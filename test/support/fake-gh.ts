// One scriptable fake `gh` for the whole suite, keyed by argv prefix. POSIX only (a shebang script).
import fs from 'node:fs';
import path from 'node:path';
import { stubDir } from './fake-bin.ts';

/** `sleepMs` holds the reply that long first: a gh that hangs. */
export type GhReply = string | { stdout?: string; stderr?: string; status?: number; sleepMs?: number };

// Reads routes.json on every call, so set() can change a reply mid-test. The longest key that
// prefixes the space-joined argv wins ('pr view' over 'pr'); an unknown call fails loudly.
const SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
let stdin = '';
if (!process.stdin.isTTY) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
const routes = JSON.parse(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'));
const line = args.join(' ');
let best = null;
for (const key of Object.keys(routes)) {
  if ((line === key || line.startsWith(key + ' ')) && (best === null || key.length > best.length)) best = key;
}
if (best === null) { process.stderr.write('fake gh: no route for ' + line + '\\n'); process.exit(1); }
const r = typeof routes[best] === 'string' ? { stdout: routes[best] } : routes[best];
if (r.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleepMs);
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 0);
`;

/**
 * Writes a `gh` that answers each call from `routes`. Spread `env` into the child env to put it
 * first on PATH; `calls()` returns each call's argv and stdin, oldest first.
 */
export function fakeGh(routes: Record<string, GhReply>): {
  dir: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  set(key: string, reply: GhReply): void;
  calls(): { args: string[]; stdin: string }[];
} {
  const dir = stubDir('forge-fake-gh-');
  const bin = path.join(dir, 'gh');
  const routesFile = path.join(dir, 'routes.json');
  const log = path.join(dir, 'calls.jsonl');
  const table: Record<string, GhReply> = { ...routes };
  fs.writeFileSync(routesFile, JSON.stringify(table));
  // Node loads an extensionless script outside any package as CommonJS, so the script uses require.
  fs.writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  return {
    dir,
    bin,
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    set(key, reply) {
      table[key] = reply;
      fs.writeFileSync(routesFile, JSON.stringify(table));
    },
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}
