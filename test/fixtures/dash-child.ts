// One `forge dash` pool for test/dash-single.test.ts, over in-memory claude children: prints
// `ready` once its pool exists, waits for <go> to exist, starts, prints {pid, wanted, lastError}
// and stays up until killed.
// Usage: node dash-child.ts <root> <go>
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { defaults } from '../../lib/core/config/load.ts';
import { createPool } from '../../lib/office/pool.ts';

const [root, go] = process.argv.slice(2);
const cfg = defaults();
Object.assign(cfg.daemon, { enabled: true, command: 'claude {session} --plugin-dir {pluginRoot} --allowedTools {allowedTools}' });
let n = 0;
const spawn: any = () => {
  const c: any = new EventEmitter();
  c.pid = 4_100_000 + ++n;
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  return c;
};
const killTree = (c: any) => setImmediate(() => c.emit('close', null, 'SIGTERM'));
const pool = createPool(root, { spawn, killTree, loadConfig: () => ({ config: cfg }), pollMs: 3_600_000, syncMs: 0 });
process.stdout.write('ready\n');
while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 5));
const s = pool.start();
process.stdout.write(JSON.stringify({ pid: process.pid, wanted: s.wanted, lastError: s.lastError }) + '\n');
setInterval(() => {}, 60_000);
