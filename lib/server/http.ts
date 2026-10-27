// The request guards and HTTP plumbing every route shares: the loopback Host check, the login (the
// per-port cookie or the token header), Origin, JSON and read guards, body readers and response writers.
import crypto from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import { SIGNED_OUT_ERROR } from '#api/constants.ts';
import type { ApiError } from '#core/types.ts';

export function isLoopbackHost(host: string | undefined): boolean {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether a socket's peer address is loopback: IPv4 127.0.0.0/8, `::1`, or IPv4 loopback mapped
 * into IPv6. Defence in depth behind the 127.0.0.1 bind, should the bind ever change.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === '::1') return true;
  const m = LOOPBACK_V4.exec(a.startsWith('::ffff:') ? a.slice(7) : a);
  return Boolean(m && m.slice(1).every((n) => Number(n) <= 255));
}

/** The most a request body may hold, in bytes. */
export const MAX_BODY = 64 * 1024;
/** How long a body may take to arrive in full. */
export const BODY_TIMEOUT_MS = 10_000;

/** A header's single value, or null when it is missing or repeated. */
function header(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The login cookie's name. Browsers scope cookies by host, not port, so the name carries the port: a
 * dashboard on another port never reads this one's cookie as its own login.
 */
export function loginCookieName(port: number): string {
  return `forge-${port}`;
}

/**
 * The value of cookie `name` in a Cookie header, or null when it is absent or appears more than once:
 * a repeated name is ambiguous, so it reads as no cookie at all.
 */
export function cookieValue(cookie: string | null, name: string): string | null {
  if (cookie === null) return null;
  let found: string | null = null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found;
}

/** Whether a request is signed in: the x-forge-token header or the `forge-<port>` cookie equals the token. */
export function authorized(req: http.IncomingMessage, token: string, port: number): boolean {
  const viaHeader = tokenMatches(header(req.headers['x-forge-token']), token);
  const viaCookie = tokenMatches(cookieValue(header(req.headers.cookie), loginCookieName(port)), token);
  return viaHeader || viaCookie;
}

/**
 * The login every /api route but POST /api/session needs: 401 SIGNED_OUT_ERROR without it. Returns true
 * when it has already answered the request.
 */
export function guardAuth(req: http.IncomingMessage, res: http.ServerResponse, token: string, port: number): boolean {
  if (!authorized(req, token, port)) return send(res, 401, 'text/plain', SIGNED_OUT_ERROR), true;
  return false;
}

/**
 * Origin, then JSON, then a declared size over MAX_BODY: the checks every POST shares, after the login.
 * Returns true when it has already answered the request.
 */
export function guardPost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!req.headers.origin || !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'json only'), true;
  if (Number(req.headers['content-length']) > MAX_BODY) return send(res, 413, 'text/plain', 'body too large'), true;
  return false;
}

/**
 * The checks every streaming or log-reading GET shares: an Origin, when sent, must be ours, and a
 * request the browser labels cross-site through Fetch Metadata is refused. A no-cors request from
 * another site (fetch no-cors, <img>, <script>) carries no Origin, which is why the second check
 * exists. There are no CORS headers, so another site can't read the reply either way. Returns
 * true when it has already answered the request.
 */
export function readGuard(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(res, 403, 'text/plain', 'cross-site'), true;
  return false;
}

export function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** A token from a header, cookie or login body against this server's, compared in constant time. */
export function tokenMatches(given: string | null, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A POST body parsed as JSON, or the 400 message: never a 500 for a client's mistake. */
export async function readJsonBody(req: http.IncomingMessage): Promise<{ body: unknown } | { error: string }> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    return { body: JSON.parse(raw || '{}') };
  } catch {
    return { error: 'body is not JSON' };
  }
}

/**
 * The body as UTF-8, decoded once at the end so a character split across chunks stays whole. Over
 * `maxBytes`, or still incomplete after `timeoutMs`, the request is destroyed (the client sees the
 * connection close) and the promise rejects with `body too large` or `body timeout`.
 */
export function readBody(req: http.IncomingMessage, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (message: string) =>
      settle(() => {
        chunks.length = 0;
        req.destroy();
        reject(new Error(message));
      });
    const timer = setTimeout(() => fail('body timeout'), opts.timeoutMs ?? BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer | string) => {
      if (settled) return;
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      bytes += buf.byteLength;
      if (bytes > maxBytes) return fail('body too large');
      chunks.push(buf);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (e) => settle(() => reject(e)));
    req.on('close', () => settle(() => reject(new Error('body incomplete'))));
  });
}

export function safeJoin(base: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

export function json(res: http.ServerResponse, data: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
}

export function jsonStatus(res: http.ServerResponse, status: number, data: ApiError): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

export function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
