import { Resolver } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';

export class TargetError extends Error {
  readonly code: 'invalid' | 'blocked' | 'dns';

  constructor(code: TargetError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const excludedV4 = ['192.88.99.0/24', '168.63.129.16/32'].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));
const excludedV6 = ['2001::/23', '2002::/16', '3fff::/20'].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));
const globalUnicast = ipaddr.IPv6.parse('2000::');

function publicAddress(value: string) {
  if (!isIP(value)) return false;
  const address = ipaddr.process(value);
  if (address.range() !== 'unicast') return false;

  if (address instanceof ipaddr.IPv4) {
    if (excludedV4.some((range) => address.match(range))) return false;
  } else {
    if (!address.match(globalUnicast, 3)) return false;
    if (excludedV6.some((range) => address.match(range))) return false;
  }

  const canonical = address.toString();
  return !Object.values(networkInterfaces()).flat().some((entry) =>
    entry && isIP(entry.address) && ipaddr.process(entry.address).toString() === canonical,
  );
}

export function hostnameOf(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function blocked() {
  return new TargetError('blocked', 'Use um endereço público. Endereços internos ou reservados são bloqueados.');
}

export function parseTarget(value: unknown): URL {
  const invalid = () => new TargetError('invalid', 'Informe uma URL válida que comece com http:// ou https://, sem credenciais.');
  if (typeof value !== 'string') throw invalid();
  const input = value.trim();
  if (input.length > 2048 || !/^https?:\/\/[^/\\?#]/i.test(input) || /[\s\\\x00-\x1f\x7f]/u.test(input)) throw invalid();

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (url.username || url.password || url.port === '0' || /^https?:\/\/[^/?#]*@/i.test(input)) throw invalid();

  const host = hostnameOf(url);
  if (isIP(host)) {
    if (!publicAddress(host)) throw blocked();
  } else {
    const domain = host.replace(/\.$/, '');
    if (!domain.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|onion)$/.test(domain)) throw blocked();
    if (domain.length > 253 || domain.split('.').some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) throw invalid();
    url.hostname = domain;
  }
  url.hash = '';
  if (url.href.length > 2048) throw invalid();
  return url;
}

export type Resolve = (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;

const resolve: Resolve = async (hostname, signal) => {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Wait for both families before choosing an address. The connection only uses a validated result.
    const [ipv4, ipv6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    return [
      ...(ipv4.status === 'fulfilled' ? ipv4.value.map((address) => ({ address, family: 4 })) : []),
      ...(ipv6.status === 'fulfilled' ? ipv6.value.map((address) => ({ address, family: 6 })) : []),
    ];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

export async function resolveTarget(url: URL, resolveHost: Resolve = resolve, signal = new AbortController().signal): Promise<LookupAddress> {
  const hostname = hostnameOf(url);
  const family = isIP(hostname);
  let addresses: LookupAddress[];
  try {
    addresses = family ? [{ address: hostname, family }] : await resolveHost(hostname, signal);
  } catch {
    signal.throwIfAborted();
    throw new TargetError('dns', 'O domínio não pôde ser resolvido.');
  }
  if (!addresses.length) throw new TargetError('dns', 'O domínio não retornou endereços.');
  if (addresses.some(({ address, family }) => isIP(address) !== family || !publicAddress(address))) throw blocked();
  return addresses[0];
}
