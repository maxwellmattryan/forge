// A local webhook endpoint for the notify tests: records every request and answers with whatever
// the test's `reply` says (a status, or 'hang' to never answer).
import http from 'node:http';
import net from 'node:net';

export interface Hit {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Reply = number | 'hang' | { status: number; headers: Record<string, string> };

export interface HookServer {
  url: string;
  port: number;
  hits: Hit[];
  /** POST bodies parsed as JSON. */
  posts: () => any[];
  /** What the next request gets: a status code, a status per attempt, or 'hang'. */
  reply: (r: Reply | ((n: number) => Reply)) => void;
  close: () => Promise<void>;
}

export async function hookServer(): Promise<HookServer> {
  const hits: Hit[] = [];
  let reply: Parameters<HookServer['reply']>[0] = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const r = typeof reply === 'function' ? reply(hits.length) : reply;
      if (r === 'hang') return;
      if (typeof r === 'object') {
        res.writeHead(r.status, r.headers);
        return res.end();
      }
      res.writeHead(r, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    posts: () => hits.filter((h) => h.method === 'POST').map((h) => JSON.parse(h.body)),
    reply: (r) => {
      reply = r;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A loopback port nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}
