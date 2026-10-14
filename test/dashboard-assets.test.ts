// The built dashboard loads nothing from another origin: the fonts are vendored woff2 files the
// server serves from the manifest, and the paper texture is an inlined data: URI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distAllowlist, startServer } from '../lib/server.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const DIST = path.join(DASHBOARD, 'dist');

function listFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
}

function builtCss(): string {
  return listFiles(DIST)
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(DIST, f), 'utf8'))
    .join('\n');
}

/** Every url(...) in a stylesheet; a quoted data: URI is consumed whole, so url()s inside it don't count. */
const cssUrls = (css: string) => [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());

test('dist loads nothing from another origin', () => {
  for (const f of listFiles(DIST)) {
    const text = fs.readFileSync(path.join(DIST, f)).toString('latin1');
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) assert.ok(!text.includes(host), `${f} mentions ${host}`);
  }
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  for (const m of html.matchAll(/\s(?:src|href)\s*=\s*["']?([^"'\s>]*)/gi)) assert.doesNotMatch(m[1], /^(https?:)?\/\//i, `index.html loads ${m[1]}`);
  const css = builtCss();
  assert.doesNotMatch(css, /@import\b/, 'the built CSS has no @import');
  const urls = cssUrls(css);
  assert.ok(urls.length >= 9, `found ${urls.length} url()s`);
  for (const u of urls) assert.ok(/^\/assets\/[\w.-]+$/.test(u) || u.startsWith('data:'), `url(${u.slice(0, 60)}) is same-origin`);
  assert.ok(urls.some((u) => u.startsWith('data:image/svg+xml')), 'the paper texture is inlined');
  assert.deepEqual(cssUrls('a{b:url("data:x,url(%23p)") url(/assets/a.woff2) url( \'/assets/b.css\' )}'), ['data:x,url(%23p)', '/assets/a.woff2', '/assets/b.css']);
});

const FAMILIES: Record<string, number[]> = { 'Space Grotesk': [500, 700], 'IBM Plex Sans': [400, 500, 600], 'IBM Plex Mono': [400, 500, 600] };

function get(port: number, p: string): Promise<{ status?: number; type?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('fonts are vendored and served', async () => {
  const css = builtCss();
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const prop = (body: string, name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]*)`).exec(body)?.[1].trim() ?? '';
  const seen: Record<string, number[]> = {};
  const allow = distAllowlist(DIST);
  const fontPaths: string[] = [];
  for (const body of faces) {
    const family = prop(body, 'font-family').replace(/["']/g, '');
    (seen[family] ??= []).push(Number(prop(body, 'font-weight')));
    assert.equal(prop(body, 'font-display'), 'swap', `${family} swaps to the fallback while loading`);
    const urls = cssUrls(prop(body, 'src'));
    assert.equal(urls.length, 1, `${family}: one source`);
    for (const u of urls) {
      assert.match(u, /^\/assets\/[\w.-]+\.woff2$/);
      const hit = allow.get(u);
      assert.ok(hit, `${u} is in the server's allowlist`);
      assert.equal(hit.type, 'font/woff2');
      assert.ok(fs.statSync(hit.file).size > 1000, `${u} exists`);
      fontPaths.push(u);
    }
  }
  for (const f of Object.keys(seen)) seen[f].sort((a, b) => a - b);
  assert.deepEqual(seen, FAMILIES);

  const ofl = fs.readFileSync(path.join(DASHBOARD, 'fonts', 'OFL.txt'), 'utf8');
  assert.match(ofl, /SIL Open Font License, Version 1\.1/);
  for (const holder of ['The Space Grotesk Project Authors', 'IBM Corp.']) assert.ok(ofl.includes(holder), `OFL.txt names ${holder}`);
  for (const f of ['Space Grotesk', 'IBM Plex Sans', 'IBM Plex Mono']) assert.ok(ofl.includes(f), `OFL.txt names ${f}`);

  const repo = tempRepo();
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    for (const u of fontPaths) {
      const r = await get(port, u);
      assert.equal(r.status, 200, u);
      assert.equal(r.type, 'font/woff2', u);
      assert.equal(r.body.subarray(0, 4).toString('latin1'), 'wOF2', `${u} is a woff2 file`);
    }
  } finally {
    server.close();
    repo.cleanup();
  }
});
