import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimLegacy, legacyOwnerId } from '../src/server/database.ts';
import type { DashboardData, Monitor } from '../src/shared/contracts.ts';
import { testServer } from './fixtures.ts';

test('migração conserva IDs e histórico e só libera o legado após transferência explícita', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pulsewatch-migration-'));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  const now = Date.now();
  legacy.exec(`CREATE TABLE monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE checks (id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('up', 'down')), http_status INTEGER, response_ms INTEGER,
    error TEXT, checked_at INTEGER NOT NULL) STRICT;
    CREATE INDEX checks_monitor_time ON checks(monitor_id, checked_at DESC, id DESC);
    CREATE INDEX checks_time ON checks(checked_at);
    INSERT INTO monitors VALUES (41, 'Legado', 'https://example.com/', ${now});
    INSERT INTO checks VALUES (77, 41, 'up', 200, 53, NULL, ${now});
    UPDATE sqlite_sequence SET seq = 90 WHERE name = 'monitors';
    PRAGMA user_version = 1;`);
  legacy.close();

  const { client, store, database, stop } = await testServer(t, { path });
  t.after(async () => { await stop(); unlinkSync(path); rmdirSync(dir); });
  assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(store.history(legacyOwnerId, 41)[0]?.id, 77);
  assert.equal(store.history(legacyOwnerId, 41)[0]?.responseMs, 53);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  const browser = client();
  const email = 'destino@example.test';
  assert.equal((await browser.signUp(email)).status, 204);
  assert.equal((await browser.signIn(email)).status, 204);
  assert.equal((await browser.send('/monitors/41/checks')).status, 404);
  const dashboard = await (await browser.send('/dashboard')).json() as DashboardData;
  assert.equal(dashboard.monitors.length, 0);
  const conflicting = await (await browser.add('https://example.com/')).json() as Monitor;
  assert.ok(conflicting.id > 90);
  assert.throws(() => claimLegacy(database, email), /duplicidade/);
  assert.equal(store.history(legacyOwnerId, 41)[0]?.id, 77);
  await browser.send(`/monitors/${conflicting.id}`, { method: 'DELETE' });
  assert.equal(claimLegacy(database, email), 1);
  assert.equal(claimLegacy(database, email), 0);
  assert.equal(store.history(legacyOwnerId, 41).length, 0);
  const history = await (await browser.send('/monitors/41/checks')).json();
  assert.equal(history.checks[0]?.id, 77);
});
