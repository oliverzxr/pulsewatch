import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function numberSetting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return value;
}

export function databasePath() {
  const path = process.env.DATABASE_PATH ?? resolve('data', 'pulsewatch.sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function authSettings(path: string, localOrigin: string) {
  const external = process.env.PUBLIC_ORIGIN !== undefined || process.env.NODE_ENV === 'production';
  const origin = external ? process.env.PUBLIC_ORIGIN ?? '' : localOrigin;
  if (external && (!origin.startsWith('https://') || URL.parse(origin)?.origin !== origin)) {
    throw new Error('Configure PUBLIC_ORIGIN com a origem HTTPS pública, sem caminho ou barra final.');
  }

  let secret = process.env.AUTH_SECRET;
  if (secret !== undefined || external) {
    if (!secret || secret.trim().length < 32) throw new Error('Configure AUTH_SECRET com pelo menos 32 caracteres aleatórios.');
  } else if (path === ':memory:') {
    secret = randomBytes(32).toString('base64url');
  } else {
    const secretPath = `${path}.auth-key`;
    try {
      writeFileSync(secretPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    secret = readFileSync(secretPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('A chave de sessão local está inválida.');
  }

  return {
    origin, secret,
    trustedOrigins: external ? [origin] : [origin, origin.replace('127.0.0.1', 'localhost')],
    registrationEnabled: !external && process.env.PULSEWATCH_DISABLE_SIGNUP !== '1',
    secureCookies: external,
  };
}
