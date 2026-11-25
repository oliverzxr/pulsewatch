import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import type { Probe } from '../src/server/probe.ts';
import { createApi } from '../src/server/api.ts';
import { createAuth } from '../src/server/auth.ts';
import { connectDatabase, legacyOwnerId, openDatabase } from '../src/server/database.ts';
import { createScheduler } from '../src/server/scheduler.ts';
import { openStore } from '../src/server/store.ts';
import type { MonitorStore } from '../src/server/store.ts';

export const password = 'test-passphrase-only';
export const testSecret = 'J2_ZnqM7k4za35dVx4q8V0mAe7Y1W9bLqT6U0hR1ukQ';

// The loopback test for the HTTPS proxy contract needs an exact public Host header.
function proxyRequest(url: string, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        const resultHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) resultHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(text || null, { status: res.statusCode, headers: resultHeaders }));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function addFixtureMonitor(store: MonitorStore, name: string, url: string, createdAt = Date.now()) {
  const monitor = store.add(legacyOwnerId, name, url, createdAt, 100);
  assert.equal(typeof monitor, 'object');
  if (typeof monitor === 'string') throw new Error(monitor);
  return monitor;
}

export async function testServer(t: TestContext, options: {
  path?: string; origin?: string; registrationEnabled?: boolean; secureCookies?: boolean; monitorLimit?: number;
  writesPerMinute?: number; intervalMs?: number; probe?: Probe;
} = {}) {
  const path = options.path ?? ':memory:';
  const database = openDatabase(path);
  const authDb = path === ':memory:' ? database : connectDatabase(path);
  const store = openStore(database);
  const intervalMs = options.intervalMs ?? 300000;
  const origin = options.origin ?? 'http://127.0.0.1:5173';
  const settings = {
    origin, trustedOrigins: [origin], secret: testSecret,
    registrationEnabled: options.registrationEnabled ?? true, secureCookies: options.secureCookies ?? false,
  };
  const auth = createAuth(authDb, settings);
  const scheduler = createScheduler(store, options.probe ?? (async () => ({
    status: 'up', httpStatus: 200, responseMs: 19, error: null, checkedAt: Date.now(),
  })), intervalMs);
  const server = createApi({ store, auth, scheduler, intervalMs, ...settings,
    monitorLimit: options.monitorLimit, writesPerMinute: options.writesPerMinute });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  scheduler.start();
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await scheduler.stop();
    if (authDb !== database) authDb.close();
    database.close();
  };
  t.after(stop);

  function client(initialCookie = '') {
    let cookie = initialCookie;
    async function send(pathname: string, options: { method?: string; body?: object; origin?: string | false; headers?: Record<string, string> } = {}) {
      const { method = 'GET', body, origin: source = origin, headers = {} } = options;
      const url = `http://127.0.0.1:${address.port}/api${pathname}`;
      const requestHeaders = {
        ...(settings.secureCookies ? { Host: new URL(origin).host } : {}),
        ...(method !== 'GET' && source ? { Origin: source } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      };
      const payload = body ? JSON.stringify(body) : undefined;
      const response = settings.secureCookies
        ? await proxyRequest(url, method, requestHeaders, payload)
        : await fetch(url, { method, headers: requestHeaders, body: payload });
      const authCookie = response.headers.getSetCookie().find((value) => /^(?:__Secure-)?pulsewatch\.session_token=/.test(value));
      if (authCookie) cookie = authCookie.split(';')[0].endsWith('=') ? '' : authCookie.split(';')[0];
      return response;
    }

    return {
      send, cookie: () => cookie,
      signUp: (email: string, name = 'Pessoa de teste') => send('/auth/sign-up/email', { method: 'POST', body: { name, email, password } }),
      signIn: (email: string, supplied = password) => send('/auth/sign-in/email', { method: 'POST', body: { email, password: supplied } }),
      signOut: () => send('/auth/sign-out', { method: 'POST', body: {} }),
      add: (url: string, name = 'Site') => send('/monitors', { method: 'POST', body: { name, url } }),
    };
  }

  return { database, store, auth, stop, client };
}
