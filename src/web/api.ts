import { useEffect, useState } from 'react';
import type { DashboardData, MonitorDetails, Period } from '../shared/contracts.ts';

export const sessionExpired = 'pulsewatch:session-expired';

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error('Não foi possível conectar à API do PulseWatch.');
  }
  if (response.status === 204) return undefined as T;
  if (response.status === 401 && (path.startsWith('/dashboard') || path.startsWith('/monitors'))) {
    window.dispatchEvent(new Event(sessionExpired));
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null) throw new RequestError(response.status, payload?.error ?? 'A API não respondeu como esperado.');
  return payload as T;
}

export interface DataResult<T> {
  data?: T;
  previous?: T;
  error: string;
  refresh: () => void;
}

export interface DataSource {
  useDashboard: (period: Period, enabled: boolean) => DataResult<DashboardData>;
  useMonitor: (id: number, period: Period) => DataResult<MonitorDetails>;
}

function usePolling<T>(path: string | null, intervalFor: (data: T) => number): DataResult<T> {
  const [snapshot, setSnapshot] = useState<{ path: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!path) return;
    const url = path;
    let pending: AbortController | undefined;
    let next: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.hidden || pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = AbortSignal.timeout(12000);
      const signal = AbortSignal.any([controller.signal, timeout]);
      let delay: number | null = 5000;
      try {
        const data = await request<T>(url, { signal });
        if (!controller.signal.aborted) {
          setSnapshot({ path: url, data });
          setFailure(null);
          delay = intervalFor(data);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          if (err instanceof RequestError && err.status === 404) {
            setSnapshot(null);
            delay = null;
          }
          setFailure({ path: url, message: timeout.aborted ? 'A API demorou para responder.' : (err as Error).message });
        }
      } finally {
        if (pending === controller) {
          pending = undefined;
          if (delay !== null) next = setTimeout(load, delay);
        }
      }
    }
    function pause() {
      clearTimeout(next);
      pending?.abort();
      pending = undefined;
    }
    function onVisibilityChange() {
      if (document.hidden) pause();
      else void load();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    void load();
    return () => { document.removeEventListener('visibilitychange', onVisibilityChange); pause(); };
  }, [path, revision, intervalFor]);

  return { data: snapshot?.path === path ? snapshot.data : undefined, previous: snapshot?.data,
    error: failure?.path === path ? failure.message : '',
    refresh: () => { setFailure(null); setRevision((value) => value + 1); } };
}

const dashboardInterval = ({ monitors }: DashboardData) =>
  monitors.some(({ checking, latest }) => checking || !latest) ? 3000 : 12000;
const detailInterval = ({ monitor }: MonitorDetails) => monitor.checking || !monitor.latest ? 3000 : 12000;

export const liveSource: DataSource = {
  useDashboard: (period, enabled) => usePolling(enabled ? `/dashboard?period=${period}` : null, dashboardInterval),
  useMonitor: (id, period) => usePolling(`/monitors/${id}?period=${period}`, detailInterval),
};
