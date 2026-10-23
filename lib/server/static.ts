// The built dashboard and job images: the dist allowlist, the page with its token, hashed assets, the
// logo, and screenshots confined to the job dir.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { exists, BUILD_DASHBOARD, DEV_DIST_DIR, PLUGIN_ROOT } from '#core/paths.ts';
import { openConfinedLog } from '#engine/environment/status.ts';
import { send } from './http.ts';
import type { RouteMatch, ServerCtx, ServerOptions } from './types.ts';

// Raster formats only: SVG can carry script, so it is never served as an image.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_SCREENSHOTS = 200;
const DIST_DIR = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
export const NOT_BUILT = `dashboard is not built: run ${BUILD_DASHBOARD}`;
export const DEV_NOT_BUILT = 'dashboard dev build is not ready: npm run dev is still building it; reload in a moment';
const DIST_ASSET = /^assets\/[\w.-]+\.(js|css|woff2)$/;
const DIST_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

/** The build a server reads its page and assets from: an explicit test dir, the dev build, or dist/. */
export function distDirFor(opts: ServerOptions): string {
  return opts.distDir ?? (opts.dev ? DEV_DIST_DIR : DIST_DIR);
}

/**
 * The page's own CSP, kept to framing so the inline theme script needs no hash: no other site may
 * frame the page (its scripts send token-bearing POSTs, so a framed page could be clickjacked), and
 * the page frames only its own origin, so a link clicked inside a mockup can't load another site.
 */
export const PAGE_CSP = "frame-src 'self'; frame-ancestors 'none'";

/** GET / and /index.html: the page, with this server's token in it. */
export function getPage(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { token, distDir, notBuilt } = ctx;
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  return page(res, token, distDir, notBuilt);
}

/** GET /assets/…: a hashed file the dist manifest lists. */
export function getAsset(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { distDir } = ctx;
  // Re-read per request so a rebuild under a running `forge dash` is picked up; the manifest is
  // tiny. The pathname is never decoded or joined: lookup is by exact string.
  const hit = distAllowlist(distDir).get(match.url.pathname);
  return hit ? immutable(res, hit) : send(res, 404, 'text/plain', 'not found');
}

/** GET /forge.png: the logo. */
export function getLogo(_ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  return sendFile(res, path.join(PLUGIN_ROOT, 'assets', 'forge.png'), 'image/png');
}

/**
 * Images under the job's `screenshots/` dir, as paths relative to the job dir. Symlinks are
 * skipped (`isFile()` is false for them), so the list never points outside the job.
 */
export function listScreenshots(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (e.isFile() && IMAGE_TYPES[path.extname(e.name).toLowerCase()]) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(dir, 'screenshots'), 0);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_SCREENSHOTS);
}

/**
 * Screenshots are agent-written files, so they are confined twice: the request path must sit under
 * `screenshots/`, and openConfinedLog must find the job dir where it should be and the file inside
 * it, a regular file with a single link, read through the descriptor that check opened.
 */
export function sendImage(res: http.ServerResponse, root: string, base: string, file: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  // The Host check can't stop another site from embedding an <img> of this URL; CORP makes the
  // browser refuse cross-origin loads, so screenshots of real data never reach a foreign page.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (path.relative(base, file).split(path.sep)[0] !== 'screenshots') return send(res, 404, 'text/plain', 'not found');
  const opened = openConfinedLog(root, base, file);
  if (typeof opened === 'string') return send(res, 404, 'text/plain', 'not found');
  let reply: [number, string, string | Buffer] = [404, 'text/plain', 'not found'];
  try {
    if (opened.size > MAX_IMAGE) reply = [413, 'text/plain', 'image too large'];
    else reply = [200, IMAGE_TYPES[path.extname(file).toLowerCase()], fs.readFileSync(opened.fd)];
  } catch {
    // An unreadable file is simply not there.
  } finally {
    fs.closeSync(opened.fd);
  }
  return send(res, ...reply);
}

/**
 * The URL paths the dashboard may serve from dist/, keyed `/assets/<file>`. The Vite manifest is
 * the allowlist and nothing under dashboard/ is served by directory, so sources, the manifest and
 * the rest of the plugin root never are. Entries that aren't plain `assets/<file>.js|css|woff2`
 * names are dropped (the vendored fonts are the only woff2; SVG and HTML never qualify), and a
 * missing or unparseable manifest allows nothing.
 */
export function distAllowlist(distDir: string): Map<string, { file: string; type: string }> {
  const out = new Map<string, { file: string; type: string }>();
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  } catch {
    return out;
  }
  if (!manifest || typeof manifest !== 'object') return out;
  const assetsDir = path.join(distDir, 'assets') + path.sep;
  const accept = (s: unknown) => {
    if (typeof s !== 'string') return;
    const m = DIST_ASSET.exec(s);
    if (!m) return;
    const file = path.resolve(distDir, s);
    if (!file.startsWith(assetsDir)) return;
    out.set('/' + s, { file, type: DIST_TYPES[m[1]] });
  };
  // Raw JSON from the build: each entry is checked before it is used.
  for (const entry of Object.values<any>(manifest)) {
    if (!entry || typeof entry !== 'object') continue;
    accept(entry.file);
    for (const k of ['css', 'assets']) if (Array.isArray(entry[k])) entry[k].forEach(accept);
  }
  return out;
}

function page(res: http.ServerResponse, token: string, distDir: string, notBuilt: string): void {
  const notReady = () => {
    res.setHeader('Cache-Control', 'no-store');
    send(res, 503, 'text/plain', notBuilt);
  };
  // The page loads only manifest files, so it counts as built only when both exist.
  if (!exists(path.join(distDir, 'manifest.json'))) return notReady();
  let html;
  try {
    html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    return notReady();
  }
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'text/html; charset=utf-8', html.replace('__FORGE_TOKEN__', token));
}

/** Hashed file names change with their content, so they are cached for good. */
function immutable(res: http.ServerResponse, hit: { file: string; type: string }): void {
  let body;
  try {
    body = fs.readFileSync(hit.file);
  } catch {
    // Removed mid-rebuild: the next page load names the new files.
    return send(res, 404, 'text/plain', 'not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  send(res, 200, hit.type, body);
}

function sendFile(res: http.ServerResponse, file: string, type: string): void {
  res.setHeader('Cache-Control', 'max-age=86400');
  send(res, 200, type, fs.readFileSync(file));
}
