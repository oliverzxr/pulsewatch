import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbe } from '../src/server/probe.ts';

const resolveHost = async () => [{ address: '8.8.8.8', family: 4 }];

test('mede uma resposta HTTP e classifica respostas fora de 2xx como indisponíveis', async () => {
  for (const statusCode of [204, 503]) {
    const probe = createProbe({ resolveHost, send: async () => ({ statusCode }) });
    const result = await probe('https://example.com');
    assert.equal(result.status, statusCode === 204 ? 'up' : 'down');
    assert.equal(result.httpStatus, statusCode);
    assert.ok(result.responseMs !== null && result.responseMs >= 0);
    assert.equal(result.error, statusCode === 204 ? null : 'http');
  }
});

test('valida e fixa um endereço resolvido a cada redirecionamento público', async () => {
  const resolved: string[] = [];
  const sent: string[] = [];
  const probe = createProbe({
    resolveHost: async (host) => { resolved.push(host); return resolveHost(); },
    send: async (url, address) => {
      assert.equal(address.address, '8.8.8.8');
      sent.push(url.hostname);
      return url.hostname === 'example.com' ? { statusCode: 301, location: 'https://example.org/' } : { statusCode: 200 };
    },
  });
  assert.equal((await probe('https://example.com')).status, 'up');
  assert.deepEqual(resolved, ['example.com', 'example.org']);
  assert.deepEqual(sent, resolved);
});

test('interrompe o redirecionamento para um destino interno antes de conectar', async () => {
  let calls = 0;
  const probe = createProbe({ resolveHost, send: async () => {
    calls += 1;
    return { statusCode: 302, location: 'http://localhost/' };
  } });
  assert.equal((await probe('https://example.com')).error, 'blocked');
  assert.equal(calls, 1);
});

test('detecta redirecionamentos circulares', async () => {
  const probe = createProbe({ resolveHost, send: async () => ({ statusCode: 302, location: '/' }) });
  assert.equal((await probe('https://example.com')).error, 'redirect');
});

test('aplica um limite total à resolução DNS e à resposta HTTP', async () => {
  const never = () => new Promise<never>(() => {});
  for (const options of [{ resolveHost: never }, { resolveHost, send: never }]) {
    const result = await createProbe({ timeoutMs: 15, ...options })('https://example.com');
    assert.equal(result.error, 'timeout');
    assert.equal(result.responseMs, null);
  }
});

test('distingue erros DNS de falhas de conexão', async () => {
  const dns = createProbe({ resolveHost: async () => [] });
  const disconnected = createProbe({ resolveHost, send: async () => { throw new Error('Connection refused'); } });
  assert.equal((await dns('https://example.com')).error, 'dns');
  assert.equal((await disconnected('https://example.com')).error, 'network');
});

test('propaga o prazo para o DNS e cancela a operação pendente', async () => {
  let aborted = false;
  const probe = createProbe({ timeoutMs: 15, resolveHost: async (_host, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return [];
  } });
  assert.equal((await probe('https://example.com')).error, 'timeout');
  assert.equal(aborted, true);
});
