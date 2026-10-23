// The request guards and HTTP plumbing every route shares: the loopback Host check, the token, Origin,
// JSON and read guards, body readers and response writers.
import crypto from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import type { ApiError } from '#core/types.ts';

export function isLoopbackHost(host: string | undefined): boolean {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Token, then Origin, then JSON: the checks every POST shares. Returns true when it has
 * already answered the request.
 */
export function guardPost(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token'), true;
  if (!req.headers.origin || !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'json only'), true;
  return false;
}

/** The token, plus a same-origin Origin when one is sent: for GETs that do work. */
export function guardToken(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token'), true;
  if (req.headers.origin !== undefined && !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
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

/** The SSE token from a query parameter, compared in constant time. */
export function tokenMatches(given: string | null, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The `?token=` an EventSource stream carries, since EventSource can't send headers. Returns true
 * when it has already answered the request.
 */
export function guardQueryToken(res: http.ServerResponse, url: URL, token: string): boolean {
  if (!tokenMatches(url.searchParams.get('token'), token)) return send(res, 403, 'text/plain', 'bad token'), true;
  return false;
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

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
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
