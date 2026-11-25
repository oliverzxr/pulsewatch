import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionUser } from '../shared/contracts.ts';
import { legacyEmail, legacyOwnerId } from './database.ts';

export const minPasswordLength = 12;
// The library defaults to Argon2id. The stored encoding is verified in the authentication tests.
const passwordOptions = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const peerHeader = 'x-pulsewatch-peer';

export function credentials(input: Record<string, unknown>) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (email.length > 254 || email === legacyEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length > 128) return null;
  return { email, password };
}

export function registration(input: Record<string, unknown>) {
  const identity = credentials(input);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!identity || identity.password.length < minPasswordLength || name.length < 2 || name.length > 80) return null;
  return { ...identity, name };
}

export type AuthAction = 'sign-up/email' | 'sign-in/email' | 'sign-out';

export function createAuth(database: DatabaseSync, config: {
  origin: string; trustedOrigins: string[]; secret: string; registrationEnabled: boolean; secureCookies: boolean;
}) {
  const auth = betterAuth({
    database, secret: config.secret, baseURL: config.origin, trustedOrigins: config.trustedOrigins,
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true, disableSignUp: !config.registrationEnabled, autoSignIn: false,
      minPasswordLength, maxPasswordLength: 128,
      password: {
        hash: (password) => hash(password, passwordOptions),
        verify: ({ hash: digest, password }) => verify(digest, password, passwordOptions),
      },
    },
    session: { expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: 'pulsewatch', useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: [peerHeader] },
    },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 8 }, '/sign-up/email': { window: 60, max: 5 } },
    },
  });

  function headersFor(req: IncomingMessage) {
    const headers = fromNodeHeaders(req.headers);
    // Never trust client-supplied proxy/IP headers. A production proxy also needs edge limits.
    headers.set(peerHeader, req.socket.remoteAddress ?? '127.0.0.1');
    return headers;
  }

  let activeCredentials = 0;
  return {
    registrationEnabled: config.registrationEnabled,
    async user(req: IncomingMessage): Promise<SessionUser | null> {
      const session = await auth.api.getSession({ headers: headersFor(req) });
      if (!session || session.user.id === legacyOwnerId) return null;
      const { id, name, email } = session.user;
      return { id, name, email };
    },
    async action(action: AuthAction, req: IncomingMessage, body?: object) {
      if (action !== 'sign-out' && activeCredentials >= 4) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
      }
      const headers = headersFor(req);
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
      const usesPassword = action !== 'sign-out';
      if (usesPassword) activeCredentials += 1;
      try {
        return await auth.handler(new Request(new URL(`/api/auth/${action}`, config.origin), {
          method: 'POST', headers, body: JSON.stringify(body ?? {}),
        }));
      } finally {
        if (usesPassword) activeCredentials -= 1;
      }
    },
    provision: (body: NonNullable<ReturnType<typeof registration>>) => auth.api.signUpEmail({ body }),
  };
}

export type AuthService = ReturnType<typeof createAuth>;
