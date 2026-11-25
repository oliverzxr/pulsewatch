import type { CheckResult, Incident, Period, Telemetry } from './contracts.ts';

const hour = 3600000;

export function periodWindow(period: Period, now: number) {
  const count = period === '24h' ? 24 : 28;
  const interval = (period === '24h' ? 1 : 6) * hour;
  const end = now + 1;
  return { count, interval, start: end - count * interval, end };
}

export interface BucketTotals {
  bucket: number;
  total: number;
  up: number;
  measured: number;
  responseSum: number;
}

export function summarize(period: Period, now: number, rows: Iterable<BucketTotals>): Telemetry {
  const { count, interval, start } = periodWindow(period, now);
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: start + index * interval, total: 0, up: 0, responseMs: null as number | null,
  }));
  let total = 0;
  let up = 0;
  let measured = 0;
  let responseSum = 0;
  for (const row of rows) {
    Object.assign(buckets[row.bucket], {
      total: row.total, up: row.up, responseMs: row.measured ? Math.round(row.responseSum / row.measured) : null,
    });
    total += row.total;
    up += row.up;
    measured += row.measured;
    responseSum += row.responseSum;
  }
  return { generatedAt: now, buckets, metrics: { total, up, responseMs: measured ? Math.round(responseSum / measured) : null } };
}

/** Receives checks in chronological order, including the start of any incident already open at the window boundary. */
export function groupIncidents(checks: Iterable<Pick<CheckResult, 'status' | 'checkedAt'>>): Incident[] {
  const incidents: Incident[] = [];
  let active: Incident | undefined;
  for (const check of checks) {
    if (check.status === 'down') {
      if (active) continue;
      active = { startedAt: check.checkedAt, recoveredAt: null };
      incidents.push(active);
    } else if (active) {
      active.recoveredAt = check.checkedAt;
      active = undefined;
    }
  }
  return incidents.reverse();
}
