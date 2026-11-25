import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DashboardData, Monitor } from '../src/shared/contracts.ts';
import { legacyOwnerId, openDatabase } from '../src/server/database.ts';
import { createScheduler } from '../src/server/scheduler.ts';
import { openStore } from '../src/server/store.ts';
import { addFixtureMonitor, testServer } from './fixtures.ts';

test('API cadastra, agenda, registra, consulta e remove monitores', async (t) => {
  const calls: string[] = [];
  const { store, client, database } = await testServer(t, { probe: async (url) => {
    calls.push(url);
    await sleep(15);
    return { status: 'up', httpStatus: 200, responseMs: 19, error: null, checkedAt: Date.now() };
  } });
  const { send: api, add, signUp, signIn } = client();
  assert.equal((await signUp('owner@example.test')).status, 204);
  assert.equal((await signIn('owner@example.test')).status, 204);
  const owner = database.prepare('SELECT id FROM "user" WHERE email = ?').get('owner@example.test')?.id as string;

  assert.equal((await api('/health')).status, 200);
  const empty = await (await api('/dashboard')).json() as DashboardData;
  assert.deepEqual(empty.monitors, []);
  assert.equal(empty.metrics.total, 0);
  assert.equal((await add('http://localhost')).status, 400);
  assert.equal((await api('/monitors', { method: 'POST', body: { name: 'Site', url: 'https://example.com' }, origin: 'https://example.net' })).status, 403);
  assert.equal((await api('/monitors', {
    method: 'POST', body: { name: 'x'.repeat(9000) },
  })).status, 413);

  const created = await add('https://example.com');
  assert.equal(created.status, 201);
  const monitor = await created.json() as Monitor;
  assert.equal((await add('https://example.com/#fragment')).status, 409);
  for (let attempt = 0; !store.history(owner, monitor.id).length && attempt < 30; attempt += 1) await sleep(10);
  const dashboard = await (await api('/dashboard?period=7d')).json() as DashboardData;
  assert.equal(dashboard.monitors[0].latest?.httpStatus, 200);
  assert.equal(dashboard.metrics.total, 1);
  assert.equal((await api(`/monitors/${monitor.id}/checks`)).status, 200);
  assert.equal((await api(`/monitors/${monitor.id}/check`, { method: 'POST' })).status, 202);
  for (let attempt = 0; store.history(owner, monitor.id).length < 2 && attempt < 30; attempt += 1) await sleep(10);
  assert.deepEqual(calls, [monitor.url, monitor.url]);
  assert.equal(store.history(owner, monitor.id).length, 2);
  assert.equal((await api(`/monitors/${monitor.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/monitors/${monitor.id}/checks`)).status, 404);
  assert.deepEqual(store.history(owner, monitor.id), []);
});

test('agendador retoma monitores pendentes e repete verificações sem sobreposição', async (t) => {
  const database = openDatabase(':memory:');
  const store = openStore(database);
  const monitor = addFixtureMonitor(store, 'Site', 'https://example.org/');
  let running = 0;
  let peak = 0;
  const scheduler = createScheduler(store, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(25);
    running -= 1;
    return { status: 'down', httpStatus: 503, responseMs: 25, error: 'http', checkedAt: Date.now() };
  }, 20);
  t.after(async () => { await scheduler.stop(); database.close(); });
  scheduler.start();
  scheduler.enqueue(monitor);
  for (let attempt = 0; store.history(legacyOwnerId, monitor.id).length < 2 && attempt < 50; attempt += 1) await sleep(10);
  assert.ok(store.history(legacyOwnerId, monitor.id).length >= 2);
  assert.equal(peak, 1);
});

test('limita a fila, reaproveita solicitações e cancela verificações removidas ou interrompidas', async (t) => {
  const database = openDatabase(':memory:');
  const store = openStore(database);
  const monitors = Array.from({ length: 4 }, (_, index) => addFixtureMonitor(store, `Site ${index}`, `https://example.com/${index}`));
  const started: string[] = [];
  const cancelled: string[] = [];
  const scheduler = createScheduler(store, async (url, signal) => {
    started.push(url);
    try { await sleep(100000, undefined, { signal }); }
    finally { if (signal?.aborted) cancelled.push(url); }
    return { status: 'up', httpStatus: 200, responseMs: 1, error: null, checkedAt: Date.now() };
  }, 300000, 1);
  t.after(async () => { await scheduler.stop(); database.close(); });
  for (const monitor of monitors.slice(0, 3)) assert.equal(scheduler.enqueue(monitor), true);
  assert.equal(scheduler.enqueue(monitors[0]), true);
  assert.equal(scheduler.enqueue(monitors[3]), false);
  await Promise.resolve();
  assert.deepEqual(started, [monitors[0].url]);
  store.remove(legacyOwnerId, monitors[0].id);
  scheduler.remove(monitors[0].id);
  for (let attempt = 0; started.length < 2 && attempt < 30; attempt += 1) await sleep(10);
  assert.deepEqual(started, [monitors[0].url, monitors[1].url]);
  assert.equal(scheduler.enqueue(monitors[3]), true);
  await scheduler.stop();
  assert.deepEqual(cancelled, started);
  assert.deepEqual(store.history(legacyOwnerId, monitors[1].id), []);
});
