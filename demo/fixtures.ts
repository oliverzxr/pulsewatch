import type { Check, DashboardData, MonitorDetails, MonitorSummary, Period } from '../src/shared/contracts.ts';
import { groupIncidents, periodWindow, summarize } from '../src/shared/telemetry.ts';
import type { BucketTotals } from '../src/shared/telemetry.ts';

const hour = 3600000;
const intervalMs = hour / 4;
const generatedAt = Date.UTC(2026, 10, 25, 15);
const sampleCount = 7 * 24 * 4;
const createdAt = generatedAt - 7 * 24 * hour;

const profiles = [
  { name: 'API de pagamentos', host: 'pagamentos', latency: 270, variation: 72, outages: [[-140, -134], [-54, -49], [-12, -9]] },
  { name: 'Autenticação', host: 'identidade', latency: 143, variation: 25, outages: [[-103, -100], [-32, -30]] },
  { name: 'Documentação', host: 'docs', latency: 81, variation: 11, outages: [] },
  { name: 'Site institucional', host: 'www', latency: 119, variation: 29, outages: [[-79, -76]] },
  { name: 'Fila de eventos', host: 'eventos', latency: 390, variation: 111, outages: [[-148, -143], [-88, -79], [-17, -12], [-3, 1]] },
];

const fixtures = profiles.map(({ name, host, latency, variation, outages }, index) => {
  const id = index + 1;
  const checks = Array.from({ length: sampleCount }, (_, step): Check => {
    const checkedAt = generatedAt - (sampleCount - 1 - step) * intervalMs;
    const hoursFromEnd = (checkedAt - generatedAt) / hour;
    const down = outages.some(([start, end]) => hoursFromEnd >= start && hoursFromEnd < end);
    const timeout = down && id === 5;
    const wave = Math.sin(step / 12 + id) + Math.sin(step / 31) * 0.65;
    const jitter = ((step * 47 + id * 19) % 29) - 14;
    const responseMs = Math.round(latency + variation * (0.5 + wave * 0.4) + jitter + (down ? 220 : 0));
    return { id: index * sampleCount + step + 1, checkedAt, status: down ? 'down' : 'up',
      httpStatus: timeout ? null : down ? 503 : 200, responseMs: timeout ? null : responseMs,
      error: timeout ? 'timeout' : down ? 'http' : null };
  });
  const monitor: MonitorSummary = { id, name, url: `https://${host}.pulsewatch.test/`, createdAt, latest: checks.at(-1)!, checking: false };
  return { monitor, checks, incidents: groupIncidents(checks) };
});

function telemetry(period: Period, checks: Iterable<Check>) {
  const { count, interval, start } = periodWindow(period, generatedAt);
  const rows: BucketTotals[] = Array.from({ length: count }, (_, bucket) => ({ bucket, total: 0, up: 0, measured: 0, responseSum: 0 }));
  for (const check of checks) {
    if (check.checkedAt < start) continue;
    const row = rows[Math.floor((check.checkedAt - start) / interval)];
    row.total += 1;
    if (check.status === 'up') row.up += 1;
    if (check.responseMs !== null) {
      row.measured += 1;
      row.responseSum += check.responseMs;
    }
  }
  return summarize(period, generatedAt, rows);
}

export function demoDashboard(period: Period): DashboardData {
  return {
    ...telemetry(period, fixtures.flatMap(({ checks }) => checks)), intervalMs,
    monitors: fixtures.map(({ monitor }) => monitor),
  };
}

export function demoMonitor(id: number, period: Period): MonitorDetails | undefined {
  const fixture = fixtures.find(({ monitor }) => monitor.id === id);
  if (!fixture) return;
  const { start } = periodWindow(period, generatedAt);
  return {
    ...telemetry(period, fixture.checks), monitor: fixture.monitor, intervalMs,
    checks: fixture.checks.slice(-100).reverse(),
    incidents: fixture.incidents.filter(({ recoveredAt }) => recoveredAt === null || recoveredAt >= start),
  };
}
