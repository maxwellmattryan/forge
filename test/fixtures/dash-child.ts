// One `forge dash` pool for test/dash-single.test.ts, over fake claude children (fakeClaude): prints
// `ready` once its pool exists, waits for <go> to exist, starts, prints {pid, wanted, lastError}
// and stays up until killed.
// Usage: node dash-child.ts <root> <go>
import fs from 'node:fs';
import { defaults } from '#core/config/load.ts';
import { createPool } from '#office/pool.ts';
import { fakeClaude } from '../helpers.ts';

const [root, go] = process.argv.slice(2);
const cfg = defaults();
Object.assign(cfg.daemon, { enabled: true, command: 'claude {session} --plugin-dir {pluginRoot} --allowedTools {allowedTools}' });
const pool = createPool(root, { claude: fakeClaude().adapter, loadConfig: () => ({ config: cfg }), pollMs: 3_600_000, syncMs: 0 });
process.stdout.write('ready\n');
while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 5));
const s = pool.start();
process.stdout.write(JSON.stringify({ pid: process.pid, wanted: s.wanted, lastError: s.lastError }) + '\n');
setInterval(() => {}, 60_000);
