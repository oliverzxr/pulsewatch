import assert from 'node:assert/strict';
import test from 'node:test';
import { demoDashboard, demoMonitor } from '../demo/fixtures.ts';
import type { CheckResult } from '../src/shared/contracts.ts';
import { legacyOwnerId, openDatabase } from '../src/server/database.ts';
import { openStore } from '../src/server/store.ts';
import { addFixtureMonitor } from './fixtures.ts';

const hour = 3600000;
const now = Date.UTC(2026, 10, 25);
const success = { status: 'up', httpStatus: 200, responseMs: 180, error: null } as const;
const failure = { status: 'down', httpStatus: null, responseMs: null, error: 'timeout' } as const;

test('detalhes agrupam incidentes, preservam o início anterior à janela e isolam as métricas por monitor', (t) => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const store = openStore(database);
  const monitor = addFixtureMonitor(store, 'API', 'https://example.com/');
  const other = addFixtureMonitor(store, 'Site', 'https://example.org/');
  const record = (offset: number, result: Omit<CheckResult, 'checkedAt'>) =>
    store.record(monitor.id, { checkedAt: now + offset * hour, ...result });

  record(-50, failure);
  record(-48, success);
  record(-41, failure);
  record(-25, failure);
  record(-20, failure);
  record(-17, success);
  record(-8, success);
  record(-8, failure);
  record(-3, failure);
  store.record(other.id, { checkedAt: now, ...success, responseMs: 999 });

  const daily = store.details(legacyOwnerId, monitor.id, '24h', now);
  assert.deepEqual(daily.metrics, { total: 5, up: 2, responseMs: 180 });
  assert.deepEqual(daily.incidents, [
    { startedAt: now - 8 * hour, recoveredAt: null },
    { startedAt: now - 41 * hour, recoveredAt: now - 17 * hour },
  ]);
  assert.equal(daily.checks.length, 9);
  const weekly = store.details(legacyOwnerId, monitor.id, '7d', now);
  assert.equal(weekly.metrics.total, 9);
  assert.equal(weekly.incidents.length, 3);
  const forbidden = store.details('outro-usuario', monitor.id, '7d', now);
  assert.equal(forbidden.metrics.total, 0);
  assert.deepEqual(forbidden.incidents, []);
  assert.deepEqual(forbidden.checks, []);
});

test('um incidente em andamento permanece visível sem verificações no período', (t) => {
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const store = openStore(database);
  const monitor = addFixtureMonitor(store, 'API', 'https://example.com/');
  const startedAt = now - 9 * 24 * hour;
  store.record(monitor.id, { checkedAt: startedAt, ...failure });
  store.record(monitor.id, { checkedAt: startedAt + 1, ...failure });

  const details = store.details(legacyOwnerId, monitor.id, '7d', now);
  assert.equal(details.metrics.total, 0);
  assert.deepEqual(details.incidents, [{ startedAt, recoveredAt: null }]);
});

test('demo estática agrega sete dias completos e mantém falhas, recuperações e latências distintas', () => {
  const week = demoDashboard('7d');
  assert.equal(week.monitors.length, 5);
  assert.equal(week.metrics.total, 5 * 7 * 24 * 4);
  assert.equal(demoDashboard('24h').metrics.total, 5 * 24 * 4);
  assert.equal(week.buckets.length, 28);
  assert.ok(week.monitors.every(({ url }) => new URL(url).hostname.endsWith('.test')));
  const monitors = week.monitors.map(({ id }) => demoMonitor(id, '7d')!);
  assert.equal(new Set(monitors.map(({ metrics }) => metrics.responseMs)).size, 5);
  assert.equal(monitors.reduce((total, { metrics }) => total + metrics.up, 0), week.metrics.up);
  assert.ok(monitors[0].incidents.every(({ startedAt, recoveredAt }) => recoveredAt !== null && recoveredAt > startedAt));
  assert.equal(monitors[0].incidents.length, 3);
  assert.equal(monitors[4].incidents[0].recoveredAt, null);
  assert.equal(demoMonitor(999, '7d'), undefined);
});
