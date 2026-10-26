// `forge service` and `forge dash --service` through the real CLI, outside any repo, with temp HOME,
// XDG_CONFIG_HOME and FORGE_HOME: status installs nothing and runs nothing, and a daemon session may
// not install the service or start the service's dashboard. No test here installs or loads a unit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BIN, cliEnv, type CliResult } from '../../helpers.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};

/** A scratch machine: a cwd outside any repo, and temp HOME, XDG_CONFIG_HOME and FORGE_HOME. */
function machine() {
  const top = tmp('forge-svc-');
  const dirs = { cwd: path.join(top, 'cwd'), home: path.join(top, 'home'), xdg: path.join(top, 'xdg'), forgeHome: path.join(top, 'fh') };
  for (const d of [dirs.cwd, dirs.home, dirs.xdg]) fs.mkdirSync(d);
  const env = { HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.xdg, FORGE_HOME: dirs.forgeHome, FORGE_ROOT: undefined };
  return { ...dirs, env };
}

/** The CLI in `cwd` with `env` on top (undefined deletes). */
function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: cliEnv('', env), encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

/** Every path under `dir`. */
const listing = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

describe('forge service', { concurrency: 4 }, () => {
  it('forge service status outside a repo', async () => {
    const m = machine();
    const r = await cli(['service', 'status', '--json'], m.cwd, m.env);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.deepEqual([s.installed, s.loaded, s.current], [false, null, null]);
    assert.equal(s.log, path.join(m.forgeHome, 'runtime', 'service.log'));
    assert.deepEqual([listing(m.home), listing(m.xdg), fs.existsSync(m.forgeHome)], [[], [], false], 'status writes nothing');
  });

  it('a daemon session may not install the service or start forge dash --service', async () => {
    const m = machine();
    const daemon = { ...m.env, FORGE_DAEMON: '1' };
    for (const sub of ['install', 'uninstall']) {
      const r = await cli(['service', sub, '--json'], m.cwd, daemon);
      assert.equal(r.status, 1, sub);
      assert.match(r.stdout + r.stderr, /forge service install\|uninstall changes what starts at login, which a daemon session may not do/, sub);
    }
    assert.equal((await cli(['service', 'status', '--json'], m.cwd, daemon)).status, 0, 'status is allowed');
    assert.deepEqual([listing(m.home), listing(m.xdg), fs.existsSync(m.forgeHome)], [[], [], false], 'nothing written');
  });
});
