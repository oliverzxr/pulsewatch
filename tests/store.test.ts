import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/server/store.ts';
import { legacyOwnerId, openDatabase } from '../src/server/database.ts';
import { addFixtureMonitor } from './fixtures.ts';

test('preserva monitores e resultados após reabrir o SQLite e remove o histórico junto ao monitor', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pulsewatch-'));
  const file = join(dir, 'test.sqlite');
  let database = openDatabase(file);
  let store = openStore(database);
  t.after(() => { database.close(); unlinkSync(file); rmdirSync(dir); });
  const now = Date.now();
  const monitor = addFixtureMonitor(store, 'Site', 'https://example.com/', now);
  assert.equal(store.add(legacyOwnerId, 'Duplicado', monitor.url, now, 100), 'duplicate');
  store.record(monitor.id, { checkedAt: now, status: 'up', httpStatus: 200, responseMs: 50, error: null });
  database.close();
  database = openDatabase(file);
  store = openStore(database);
  assert.equal(store.list(legacyOwnerId)[0].latest?.responseMs, 50);
  assert.equal(store.history(legacyOwnerId, monitor.id).length, 1);
  assert.deepEqual(store.snapshot(legacyOwnerId, '24h', now).metrics, { total: 1, up: 1, responseMs: 50 });
  assert.equal(store.remove(legacyOwnerId, monitor.id), true);
  store.record(monitor.id, { checkedAt: now, status: 'up', httpStatus: 200, responseMs: 50, error: null });
  assert.deepEqual(store.history(legacyOwnerId, monitor.id), []);
  assert.deepEqual(store.list(legacyOwnerId), []);
});

test('agrega por período e preserva a ausência de medições no gráfico', (t) => {
  const database = openDatabase(':memory:');
  const store = openStore(database);
  t.after(() => database.close());
  const now = Date.now();
  const monitor = addFixtureMonitor(store, 'API', 'https://example.com/', now);
  store.record(monitor.id, { checkedAt: now - 2 * 86400000, status: 'up', httpStatus: 200, responseMs: 100, error: null });
  store.record(monitor.id, { checkedAt: now, status: 'down', httpStatus: null, responseMs: null, error: 'timeout' });
  const daily = store.snapshot(legacyOwnerId, '24h', now);
  const weekly = store.snapshot(legacyOwnerId, '7d', now);
  assert.equal(daily.buckets.length, 24);
  assert.equal(weekly.buckets.length, 28);
  assert.equal(daily.buckets[0].total, 0);
  assert.equal(daily.buckets[0].responseMs, null);
  assert.equal(daily.buckets.at(-1)?.total, 1);
  assert.deepEqual(daily.metrics, { total: 1, up: 0, responseMs: null });
  assert.deepEqual(weekly.metrics, { total: 2, up: 1, responseMs: 100 });
});

test('pondera a média do período pelo total de respostas HTTP de cada faixa', (t) => {
  const database = openDatabase(':memory:');
  const store = openStore(database);
  t.after(() => database.close());
  const now = Date.now();
  const monitor = addFixtureMonitor(store, 'API', 'https://example.com/', now);
  const success = { status: 'up', httpStatus: 200, error: null } as const;
  store.record(monitor.id, { ...success, checkedAt: now - 7200000, responseMs: 100 });
  store.record(monitor.id, { ...success, checkedAt: now, responseMs: 310 });
  store.record(monitor.id, { ...success, checkedAt: now, responseMs: 330 });
  store.record(monitor.id, { checkedAt: now, status: 'down', httpStatus: null, responseMs: null, error: 'timeout' });
  const daily = store.snapshot(legacyOwnerId, '24h', now);
  assert.deepEqual(daily.metrics, { total: 4, up: 3, responseMs: 247 });
  assert.equal(daily.buckets.at(-1)?.responseMs, 320);
});
