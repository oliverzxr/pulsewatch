import type { Monitor } from '../shared/contracts.ts';
import type { Probe } from './probe.ts';
import type { MonitorStore } from './store.ts';

export function createScheduler(store: MonitorStore, probe: Probe, intervalMs: number, concurrency = 4) {
  const queued = new Map<number, Monitor>();
  const active = new Map<number, { promise: Promise<void>; controller: AbortController }>();
  const queueLimit = concurrency * 2;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  function pump() {
    if (stopped) return;
    for (const [id, monitor] of queued) {
      if (active.size >= concurrency) break;
      queued.delete(id);
      const controller = new AbortController();
      const { signal } = controller;
      const promise = Promise.resolve().then(() => probe(monitor.url, signal)).then((result) => {
        if (!signal.aborted) store.record(id, result);
      }).catch((error: unknown) => {
        if (!signal.aborted) console.error('Falha ao executar verificação do monitor', id, error);
      }).finally(() => {
        active.delete(id);
        pump();
      });
      active.set(id, { promise, controller });
    }
  }

  function scan() {
    try {
      if (queued.size < queueLimit) {
        for (const monitor of store.due(Date.now() - intervalMs, queueLimit + active.size)) {
          if (queued.size >= queueLimit) break;
          if (!active.has(monitor.id)) queued.set(monitor.id, monitor);
        }
      }
      pump();
    } catch (error) {
      console.error('Falha ao consultar verificações pendentes', error);
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      scan();
      timer = setInterval(scan, Math.min(5000, intervalMs));
      timer.unref();
    },
    enqueue(monitor: Monitor) {
      if (stopped) return false;
      if (active.has(monitor.id) || queued.has(monitor.id)) return true;
      if (queued.size >= queueLimit) return false;
      queued.set(monitor.id, monitor);
      pump();
      return true;
    },
    remove(id: number) {
      queued.delete(id);
      active.get(id)?.controller.abort();
    },
    checking: (id: number) => active.has(id) || queued.has(id),
    async stop() {
      stopped = true;
      clearInterval(timer);
      queued.clear();
      const jobs = [...active.values()];
      for (const { controller } of jobs) controller.abort();
      await Promise.all(jobs.map(({ promise }) => promise));
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
