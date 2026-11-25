import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, resolveTarget, TargetError } from '../src/server/target.ts';

test('normaliza a URL pública, preserva a consulta e remove o fragmento', () => {
  assert.equal(parseTarget(' HTTPS://EXAMPLE.COM:443/status?full=1#section ').href, 'https://example.com/status?full=1');
  assert.equal(parseTarget('https://example.com./').href, 'https://example.com/');
});

test('rejeita protocolos não HTTP, credenciais e URLs malformadas', () => {
  for (const url of ['example.com', 'file:///example', 'https://user@example.com', 'http:///example.com', 'http://example.com:0']) {
    assert.throws(() => parseTarget(url), { code: 'invalid' });
  }
});

test('rejeita destinos locais e faixas de uso especial em IPv4 e IPv6', () => {
  const hosts = ['localhost', 'service.internal', 'router.home.arpa', '127.0.0.1', '10.0.0.1', '169.254.169.254',
    '100.64.0.1', '192.0.2.1', '[::1]', '[fc00::1]', '[::ffff:192.168.1.1]', '[64:ff9b::1]', '[3fff::1]'];
  for (const host of hosts) assert.throws(() => parseTarget(`http://${host}`), { code: 'blocked' });
});

test('aceita endereços públicos e rejeita uma resolução mista integralmente', async () => {
  const target = parseTarget('https://example.com');
  const address = { address: '8.8.8.8', family: 4 };
  assert.deepEqual(await resolveTarget(target, async () => [address]), address);
  await assert.rejects(resolveTarget(target, async () => [address, { address: '192.168.0.1', family: 4 }]), { code: 'blocked' });
  await assert.rejects(resolveTarget(target, async () => []), { code: 'dns' });
  await assert.rejects(resolveTarget(target, async () => { throw new Error('DNS'); }), TargetError);
});
