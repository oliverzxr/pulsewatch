import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserSession, DashboardData, Monitor, MonitorDetails } from '../src/shared/contracts.ts';
import { authSettings } from '../src/server/settings.ts';
import { password, testSecret, testServer } from './fixtures.ts';

test('cadastro e login protegem credenciais, sessão e mutações contra CSRF', async (t) => {
  const { client, database } = await testServer(t);
  const visitor = client();
  assert.equal((await visitor.send('/dashboard')).status, 401);
  assert.deepEqual(await (await visitor.send('/session')).json(), { user: null, registrationEnabled: true });
  const email = 'primeira@example.test';
  const unsafeSignup = await visitor.send('/auth/sign-up/email', { method: 'POST', origin: 'https://example.org',
    body: { email, name: 'Primeira', password } });
  assert.equal(unsafeSignup.status, 403);
  const created = await visitor.signUp(email, 'Primeira');
  const duplicate = await visitor.signUp(email.toUpperCase(), 'Outro nome');
  assert.equal(created.status, 204);
  assert.equal(duplicate.status, created.status);
  assert.equal(await created.text(), await duplicate.text());
  assert.equal(visitor.cookie(), '');
  const row = database.prepare('SELECT password FROM "account"').get();
  assert.match(String(row?.password), /^\$argon2id\$.*m=19456,t=2,p=1\$/);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM "account"').get()?.n, 1);

  const known = await visitor.signIn(email, 'senha-incorreta');
  const unknown = await visitor.signIn('inexistente@example.test', 'senha-incorreta');
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await known.json(), await unknown.json());
  const loggedIn = await visitor.signIn(email);
  assert.equal(loggedIn.status, 204);
  assert.equal(await loggedIn.text(), '');
  assert.match(loggedIn.headers.getSetCookie().join(';'), /HttpOnly/i);
  assert.match(loggedIn.headers.getSetCookie().join(';'), /SameSite=Lax/i);
  const state = await (await visitor.send('/session')).json() as BrowserSession;
  assert.deepEqual(Object.keys(state.user!).sort(), ['email', 'id', 'name']);
  assert.equal(state.user?.name, 'Primeira');
  assert.equal((await visitor.send('/monitors', { method: 'POST', origin: false,
    body: { name: 'Teste', url: 'https://example.com/' } })).status, 403);
  assert.equal((await visitor.send('/auth/sign-out', { method: 'POST', origin: 'https://example.org', body: {} })).status, 403);
  assert.equal((await visitor.send('/dashboard')).status, 200);
  const staleCookie = visitor.cookie();
  assert.equal((await visitor.signOut()).status, 204);
  assert.equal((await client(staleCookie).send('/dashboard')).status, 401);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM "session"').get()?.n, 0);
});

test('duas contas isolam monitores, histórico, métricas e ações', async (t) => {
  const { client } = await testServer(t, { monitorLimit: 1 });
  const a = client();
  const b = client();
  for (const [account, email] of [[a, 'a@example.test'], [b, 'b@example.test']] as const) {
    assert.equal((await account.signUp(email)).status, 204);
    assert.equal((await account.signIn(email)).status, 204);
  }
  const created = await a.add('https://example.com/', 'Monitor A');
  assert.equal(created.status, 201);
  const monitor = await created.json() as Monitor;
  const otherResponse = await b.add('https://example.com/', 'Monitor B');
  assert.equal(otherResponse.status, 201);
  const other = await otherResponse.json() as Monitor;
  assert.notEqual(other.id, monitor.id);
  assert.equal((await a.add('https://example.org/')).status, 409);
  for (const attempt of [
    { path: `/monitors/${monitor.id}?period=7d`, method: 'GET' },
    { path: `/monitors/${monitor.id}/checks`, method: 'GET' },
    { path: `/monitors/${monitor.id}`, method: 'DELETE' },
    { path: `/monitors/${monitor.id}`, method: 'PATCH' },
    { path: `/monitors/${monitor.id}/check`, method: 'POST' },
  ]) assert.equal((await b.send(attempt.path, { method: attempt.method })).status, 404);
  assert.equal((await a.send(`/monitors/${other.id}/checks`)).status, 404);
  assert.equal((await client().send(`/monitors/${monitor.id}`)).status, 401);
  assert.equal((await a.send(`/monitors/${monitor.id}?period=30d`)).status, 400);

  for (const [account, own] of [[a, monitor], [b, other]] as const) {
    const dashboard = await (await account.send('/dashboard?period=7d')).json() as DashboardData;
    assert.deepEqual(dashboard.monitors.map(({ id }) => id), [own.id]);
    assert.equal(dashboard.metrics.total, 1);
    assert.equal(dashboard.buckets.reduce((total, bucket) => total + bucket.total, 0), 1);
    const history = await (await account.send(`/monitors/${own.id}/checks`)).json();
    assert.equal(history.checks.length, 1);
    const response = await account.send(`/monitors/${own.id}?period=7d`);
    assert.equal(response.status, 200);
    const details = await response.json() as MonitorDetails;
    assert.equal(details.monitor.id, own.id);
    assert.deepEqual(details.checks, history.checks);
    assert.equal(details.metrics.total, 1);
    assert.deepEqual(details.incidents, []);
  }
});

test('sessão persistente sobrevive ao reinício, expira e admite novo login', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pulsewatch-session-'));
  const path = join(dir, 'session.sqlite');
  const first = await testServer(t, { path });
  const browser = first.client();
  const email = 'persistente@example.test';
  assert.equal((await browser.signUp(email)).status, 204);
  assert.equal((await browser.signIn(email)).status, 204);
  assert.equal((await browser.add('https://example.com/')).status, 201);
  const cookie = browser.cookie();
  await first.stop();

  const second = await testServer(t, { path });
  t.after(async () => { await second.stop(); unlinkSync(path); rmdirSync(dir); });
  const restored = second.client(cookie);
  assert.equal((await restored.send('/dashboard')).status, 200);
  second.database.prepare('UPDATE "session" SET "expiresAt" = ?').run('2000-01-01T00:00:00.000Z');
  assert.equal((await restored.send('/dashboard')).status, 401);
  assert.equal((await restored.signIn(email)).status, 204);
  assert.notEqual(restored.cookie(), cookie);
  const dashboard = await (await restored.send('/dashboard')).json() as DashboardData;
  assert.equal(dashboard.monitors.length, 1);
});

test('modo externo exige origem conhecida, usa Secure e bloqueia cadastro HTTP', async (t) => {
  const { auth, client } = await testServer(t, { origin: 'https://pulsewatch.example', secureCookies: true,
    registrationEnabled: false });
  const browser = client();
  assert.equal((await browser.signUp('externa@example.test')).status, 403);
  assert.equal((await browser.send('/health', { headers: { Host: 'outsider.example' } })).status, 403);
  // An operator provisions on the local database using the library, never through HTTP signup.
  assert.equal(auth.registrationEnabled, false);
  const production = await testServer(t, { origin: 'https://pulsewatch.example', secureCookies: true });
  await production.auth.provision({ email: 'operador@example.test', name: 'Operador', password });
  const response = await production.client().signIn('operador@example.test');
  assert.equal(response.status, 204);
  assert.match(response.headers.getSetCookie().join(';'), /__Secure-pulsewatch\.session_token=.*; Secure/i);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('configuração externa falha sem TLS ou segredo e desativa o cadastro por padrão', (t) => {
  const env = { ...process.env };
  t.after(() => {
    for (const key of ['NODE_ENV', 'PUBLIC_ORIGIN', 'AUTH_SECRET']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  process.env.NODE_ENV = 'production';
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.AUTH_SECRET;
  assert.throws(() => authSettings(':memory:', 'http://127.0.0.1:3001'), /PUBLIC_ORIGIN/);
  process.env.PUBLIC_ORIGIN = 'https://pulsewatch.example';
  assert.throws(() => authSettings(':memory:', 'http://127.0.0.1:3001'), /AUTH_SECRET/);
  process.env.AUTH_SECRET = testSecret;
  const config = authSettings(':memory:', 'http://127.0.0.1:3001');
  assert.equal(config.registrationEnabled, false);
  assert.equal(config.secureCookies, true);
});

test('limita tentativas de autenticação e escritas por conta', async (t) => {
  const { client } = await testServer(t, { writesPerMinute: 1 });
  const browser = client();
  assert.equal((await browser.signUp('limite@example.test')).status, 204);
  assert.equal((await browser.signIn('limite@example.test')).status, 204);
  assert.equal((await browser.add('https://example.com/')).status, 201);
  assert.equal((await browser.add('https://example.org/')).status, 429);
  for (let n = 0; n < 7; n += 1) {
    assert.equal((await browser.signIn('limite@example.test', 'senha-incorreta')).status, 401);
  }
  const limited = await browser.send('/auth/sign-in/email', { method: 'POST',
    body: { email: 'limite@example.test', password: 'senha-incorreta' },
    headers: { 'X-PulseWatch-Peer': '203.0.113.1', 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('agendador continua registrando verificações depois do logout', async (t) => {
  const { client, database, store } = await testServer(t, { intervalMs: 30 });
  const browser = client();
  const email = 'intervalo@example.test';
  assert.equal((await browser.signUp(email)).status, 204);
  assert.equal((await browser.signIn(email)).status, 204);
  const response = await browser.add('https://example.com/');
  assert.equal(response.status, 201);
  const monitor = await response.json() as Monitor;
  const user = database.prepare('SELECT id FROM "user" WHERE email = ?').get(email)?.id as string;
  assert.equal((await browser.signOut()).status, 204);
  const count = store.history(user, monitor.id).length;
  for (let attempt = 0; store.history(user, monitor.id).length <= count && attempt < 40; attempt += 1) await sleep(12);
  assert.ok(store.history(user, monitor.id).length > count);
  assert.equal((await browser.send(`/monitors/${monitor.id}/checks`)).status, 401);
});
