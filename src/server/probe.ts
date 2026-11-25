import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { CheckError, CheckResult } from '../shared/contracts.ts';
import { parseTarget, resolveTarget, TargetError } from './target.ts';
import type { Resolve } from './target.ts';

interface ProbeResponse {
  statusCode: number;
  location?: string;
}

export type RequestHeaders = (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<ProbeResponse>;
export type Probe = (url: string, signal?: AbortSignal) => Promise<CheckResult>;

const requestHeaders: RequestHeaders = (url, address, signal) => new Promise((resolve, reject) => {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = request(url, {
    method: 'GET',
    agent: false,
    signal,
    family: address.family,
    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    headers: { 'User-Agent': 'PulseWatch/0.1', Connection: 'close' },
  }, (res) => {
    resolve({ statusCode: res.statusCode ?? 0, location: res.headers.location });
    res.destroy();
  });
  req.on('error', reject);
  req.end();
});

function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 4;

export function createProbe({ timeoutMs = 8000, resolveHost, send = requestHeaders }: {
  timeoutMs?: number;
  resolveHost?: Resolve;
  send?: RequestHeaders;
} = {}): Probe {
  return async (input, cancellation) => {
    const start = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = cancellation ? AbortSignal.any([deadline.signal, cancellation]) : deadline.signal;
    const failure = (error: CheckError): CheckResult => ({
      status: 'down', httpStatus: null, responseMs: null, error, checkedAt: Date.now(),
    });

    try {
      let url = parseTarget(input);
      const visited = new Set<string>();
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        visited.add(url.href);
        signal.throwIfAborted();
        const address = await beforeAbort(resolveTarget(url, resolveHost, signal), signal);
        signal.throwIfAborted();
        const { statusCode, location } = await beforeAbort(send(url, address, signal), signal);

        if (redirectStatuses.has(statusCode) && location) {
          if (hop === maxRedirects) return failure('redirect');
          let destination: string;
          try {
            destination = new URL(location, url).href;
          } catch {
            return failure('redirect');
          }
          url = parseTarget(destination);
          if (visited.has(url.href)) return failure('redirect');
          continue;
        }

        const up = statusCode >= 200 && statusCode < 300;
        return {
          status: up ? 'up' : 'down', httpStatus: statusCode, responseMs: Math.round(performance.now() - start),
          error: up ? null : 'http', checkedAt: Date.now(),
        };
      }
      return failure('redirect');
    } catch (error) {
      cancellation?.throwIfAborted();
      if (deadline.signal.aborted) return failure('timeout');
      if (error instanceof TargetError) return failure(error.code === 'dns' ? 'dns' : 'blocked');
      return failure('network');
    } finally {
      clearTimeout(timer);
    }
  };
}
