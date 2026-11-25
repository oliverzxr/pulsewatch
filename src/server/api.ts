import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DashboardData, MonitorDetails } from '../shared/contracts.ts';
import { credentials, registration } from './auth.ts';
import type { AuthAction, AuthService } from './auth.ts';
import type { Scheduler } from './scheduler.ts';
import type { MonitorStore } from './store.ts';
import { parseTarget, TargetError } from './target.ts';

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const missingMonitor = () => new ApiError(404, 'Monitor não encontrado.');
function selectedPeriod(params: URLSearchParams) {
  const period = params.get('period') ?? '24h';
  if (period !== '24h' && period !== '7d') throw new ApiError(400, 'Período inválido.');
  return period;
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Envie o corpo da solicitação como application/json.');
  }
  const limit = 8192;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new ApiError(413, 'O corpo da solicitação é muito grande.');
    }
    chunks.push(chunk);
  }

  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'Envie um objeto JSON válido.');
  }
}

export function createApi({ store, scheduler, intervalMs, webRoot, auth, origin, trustedOrigins, secureCookies, monitorLimit = 10, writesPerMinute = 30 }: {
  store: MonitorStore;
  scheduler: Scheduler;
  intervalMs: number;
  webRoot?: string;
  auth: AuthService;
  origin: string;
  trustedOrigins: string[];
  secureCookies: boolean;
  monitorLimit?: number;
  writesPerMinute?: number;
}) {
  const publicHost = new URL(origin).host;
  const origins = new Set(trustedOrigins);
  const writes = new Map<string, number>();
  let writeWindow = -1;

  function limitWrite(userId: string, res: ServerResponse) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    if (minute !== writeWindow) { writes.clear(); writeWindow = minute; }
    const count = writes.get(userId) ?? 0;
    if (count >= writesPerMinute) {
      res.setHeader('Retry-After', String(Math.ceil((60000 - now % 60000) / 1000)));
      throw new ApiError(429, 'Muitas operações nesta conta. Tente novamente em instantes.');
    }
    writes.set(userId, count + 1);
  }

  async function handleAuth(action: AuthAction, req: IncomingMessage, res: ServerResponse) {
    if (action === 'sign-up/email' && !auth.registrationEnabled) {
      throw new ApiError(403, 'O cadastro público está desabilitado.');
    }
    const input = await readJson(req);
    const body = action === 'sign-up/email' ? registration(input) : action === 'sign-in/email' ? credentials(input) : {};
    if (!body) {
      if (action === 'sign-in/email') throw new ApiError(401, 'E-mail ou senha inválidos.');
      throw new ApiError(400, 'Informe um nome, um e-mail válido e uma senha de 12 a 128 caracteres.');
    }
    const response = await auth.action(action, req, body);
    if (response.status === 429) {
      res.setHeader('Retry-After', response.headers.get('Retry-After') ?? response.headers.get('X-Retry-After') ?? '60');
      throw new ApiError(429, 'Muitas tentativas. Aguarde um pouco e tente novamente.');
    }
    if (!response.ok) {
      if (action === 'sign-in/email' && (response.status === 400 || response.status === 401 || response.status === 403)) {
        throw new ApiError(401, 'E-mail ou senha inválidos.');
      }
      if (action === 'sign-up/email' && response.status === 400) throw new ApiError(400, 'Confira os dados do cadastro.');
      throw new ApiError(503, 'Não foi possível concluir a operação. Tente novamente em instantes.');
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    // Better Auth can return the token in JSON. Browser clients get only the HttpOnly cookie.
    res.writeHead(204).end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const { localPort } = req.socket;
    const host = req.headers.host;
    const localHost = host === `127.0.0.1:${localPort}` || host === `localhost:${localPort}` ||
      (localPort === 80 && (host === '127.0.0.1' || host === 'localhost'));
    if (!host || (host !== publicHost && (secureCookies || !localHost))) throw new ApiError(403, 'Endereço de acesso inválido.');
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new ApiError(400, 'Caminho inválido.');
    const method = req.method;
    const { pathname, searchParams } = new URL(req.url, origin);
    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Cookie');
      const source = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
        (method !== 'GET' && method !== 'HEAD' && (!source || !origins.has(source)))) {
        throw new ApiError(403, 'Origem da solicitação não autorizada.');
      }
    }

    if (pathname === '/api/health' && method === 'GET') {
      return json(res, 200, { status: 'ok' });
    }
    if (pathname === '/api/session' && method === 'GET') {
      return json(res, 200, { user: await auth.user(req), registrationEnabled: auth.registrationEnabled });
    }
    if (method === 'POST' && pathname === '/api/auth/sign-up/email') return handleAuth('sign-up/email', req, res);
    if (method === 'POST' && pathname === '/api/auth/sign-in/email') return handleAuth('sign-in/email', req, res);
    if (method === 'POST' && pathname === '/api/auth/sign-out') return handleAuth('sign-out', req, res);

    const match = /^\/api\/monitors\/([1-9]\d*)(?:\/(checks|check))?$/.exec(pathname);
    if (pathname === '/api/dashboard' || pathname === '/api/monitors' || match) {
      const user = await auth.user(req);
      if (!user) throw new ApiError(401, 'Entre para acessar sua conta.');
      if (method !== 'GET' && method !== 'HEAD') limitWrite(user.id, res);
      return handleMonitors(req, res, user.id, pathname, searchParams, match);
    }

    if (webRoot && (method === 'GET' || method === 'HEAD')) {
      let file: string | undefined;
      if (pathname === '/' || pathname === '/entrar' || pathname === '/cadastro') file = 'index.html';
      else if (pathname === '/pulsewatch.png') file = 'pulsewatch.png';
      else if (/^\/assets\/[a-z0-9_.-]+$/i.test(pathname)) file = pathname.slice(1);
      if (file) {
        try {
          const data = await readFile(join(webRoot, file));
          res.writeHead(200, {
            'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
            'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          });
          return res.end(method === 'HEAD' ? undefined : data);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    throw new ApiError(404, 'Rota não encontrada.');
  }

  async function handleMonitors(req: IncomingMessage, res: ServerResponse, owner: string, pathname: string,
    searchParams: URLSearchParams, match: RegExpExecArray | null) {
    const method = req.method;
    if (pathname === '/api/dashboard' && method === 'GET') {
      const period = selectedPeriod(searchParams);
      const generatedAt = Date.now();
      const dashboard: DashboardData = {
        monitors: store.list(owner).map((monitor) => ({ ...monitor, checking: scheduler.checking(monitor.id) })),
        intervalMs, ...store.snapshot(owner, period, generatedAt),
      };
      return json(res, 200, dashboard);
    }
    if (pathname === '/api/monitors' && method === 'POST') {
      const input = await readJson(req);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) throw new ApiError(400, 'Informe um nome com até 80 caracteres.');
      const url = parseTarget(input.url);
      const monitor = store.add(owner, name, url.href, Date.now(), monitorLimit);
      if (monitor === 'duplicate') throw new ApiError(409, 'Essa URL já está sendo monitorada.');
      if (monitor === 'limit') throw new ApiError(409, `A conta atingiu o limite de ${monitorLimit} monitores.`);
      scheduler.enqueue(monitor);
      return json(res, 201, monitor);
    }

    if (match) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id)) throw missingMonitor();
      const action = match[2];
      const monitor = store.get(owner, id);
      if (!monitor) throw missingMonitor();
      if (!action && method === 'GET') {
        const details = store.details(owner, id, selectedPeriod(searchParams), Date.now());
        return json(res, 200, {
          ...details, monitor: { ...monitor, latest: details.checks[0] ?? null, checking: scheduler.checking(id) }, intervalMs,
        } satisfies MonitorDetails);
      }
      if (!action && method === 'DELETE') {
        if (!store.remove(owner, id)) throw missingMonitor();
        scheduler.remove(id);
        res.writeHead(204);
        return res.end();
      }
      if (action === 'checks' && method === 'GET') {
        return json(res, 200, { monitor, checking: scheduler.checking(id), checks: store.history(owner, id) });
      }
      if (action === 'check' && method === 'POST') {
        if (!scheduler.enqueue(monitor)) {
          res.setHeader('Retry-After', '5');
          throw new ApiError(503, 'A fila de verificações está cheia. Tente novamente em instantes.');
        }
        return json(res, 202, { checking: true });
      }
    }
    throw new ApiError(405, 'Método não permitido.');
  }

  return createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.destroyed) return;
      if (error instanceof ApiError) return json(res, error.status, { error: error.message });
      if (error instanceof TargetError) return json(res, 400, { error: error.message });
      console.error('Falha na API', error instanceof Error ? error.name : 'Erro');
      json(res, 500, { error: 'Não foi possível concluir a solicitação.' });
    });
  });
}
