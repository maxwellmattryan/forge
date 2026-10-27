// `forge dash` and `forge daemon status` trust the machine record (<FORGE_HOME>/dashboard.json), or an
// older per-repo .forge/runtime/dashboard.json, only when it names a live process with `forge` in the
// script position, then `dash`, that started when the record says, at a loopback url: a planted record
// never gets a process signalled or its url shown. A second repo's `forge dash` opens the one running
// machine dashboard, and a daemon session may only ask for that report. Each test has its own FORGE_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { forgeAsync, tempRepo, waitFor } from '../../helpers.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { TRUST_ENV, trustDigest } from '#core/config/load.ts';
import { processStartMs } from '#core/os/process.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { dashboardLoginFile, legacyDashboardFile, machineDashboardFile } from '#engine/ops/dashboard-record.ts';
import { addProject, defaultProjectName } from '#engine/project/machine-index.ts';
import { trustApproved } from '#engine/project/trust-approval.ts';

const HOUR_MS = 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const json = (stdout: string) => JSON.parse(stdout);

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
/** A fresh FORGE_HOME (not yet created) in its own scratch dir. */
function freshHome(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-home-')));
  made.push(d);
  return path.join(d, 'home');
}

type Argv = 'foreign' | 'wordsAfterE' | 'script';

/**
 * A live process whose command line is: `foreign`, a plain `node -e` loop; `wordsAfterE`, the same
 * with `<dir>/bin/forge dash` after the script (node ignores them, so they only change what ps
 * shows, outside the script position); `script`, `node <dir>/bin/forge dash` running a stub that
 * idles, so `forge` sits in the script position.
 */
function spawnIdle(dir: string, argv: Argv): ChildProcess {
  const bin = path.join(dir, 'bin', 'forge');
  if (argv === 'script') {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'setInterval(() => {}, 1e3);\n');
    return spawn(process.execPath, [bin, 'dash'], { stdio: 'ignore' });
  }
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', ...(argv === 'wordsAfterE' ? [bin, 'dash'] : [])], { stdio: 'ignore' });
}

function setupRepo(): ReturnType<typeof tempRepo> {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\ndaemon:\n  enabled: false\n`);
  return repo;
}

test('dash --stop signals only a proven dashboard', async () => {
  type Row = { name: string; argv: Argv; url: string; startOffsetMs: number; proven: boolean; legacy?: boolean; skip?: boolean };
  // Native Windows has no start-time probe, so no record is ever proven there.
  const win = process.platform === 'win32';
  const rows: Row[] = [
    { name: 'foreign process, matching start', argv: 'foreign', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: false },
    { name: 'foreign process, start 1 h off', argv: 'foreign', url: 'http://127.0.0.1:7999', startOffsetMs: -HOUR_MS, proven: false },
    { name: 'forge dash words after -e', argv: 'wordsAfterE', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: false },
    { name: 'forge dash argv, non-loopback url', argv: 'script', url: 'http://evil.example/', startOffsetMs: 0, proven: false },
    { name: 'proven dashboard', argv: 'script', url: 'http://127.0.0.1:7999', startOffsetMs: 0, proven: true, skip: win },
    { name: 'proven legacy per-repo dashboard', argv: 'script', url: 'http://127.0.0.1:7998', startOffsetMs: 0, proven: true, legacy: true, skip: win },
  ];
  const children: ChildProcess[] = [];
  const repos: ReturnType<typeof tempRepo>[] = [];
  try {
    const usageRepo = setupRepo();
    repos.push(usageRepo);
    const bogus = await forgeAsync(usageRepo.dir, ['dash', 'bogus', '--json'], { FORGE_HOME: freshHome() });
    assert.equal(bogus.status, 2, `${bogus.stdout}${bogus.stderr}`);
    assert.equal(json(bogus.stdout).error.message, 'unknown dash subcommand "bogus"; run forge help dash');
    for (const row of rows) {
      if (row.skip) continue;
      const repo = setupRepo();
      repos.push(repo);
      const home = freshHome();
      const env = { FORGE_HOME: home };
      const child = spawnIdle(repo.dir, row.argv);
      children.push(child);
      const pid = child.pid!;
      const startedAt = new Date((processStartMs(pid) ?? Date.now()) + row.startOffsetMs).toISOString();
      const file = row.legacy ? legacyDashboardFile(repo.dir) : machineDashboardFile(home);
      writeJsonAtomic(file, { pid, url: row.url, startedAt });

      const status = await forgeAsync(repo.dir, ['daemon', 'status', '--json'], env);
      assert.equal(status.status, 0, `${row.name}: ${status.stderr}`);
      // A record written without permissionMode (an older Forge, or a run without the flag) reports null.
      assert.deepEqual(json(status.stdout).dashboard, row.proven ? { pid, url: row.url, alive: true, permissionMode: null } : { pid, url: null, alive: false, permissionMode: null }, `${row.name}: daemon status`);
      assert.ok(!status.stdout.includes('evil.example'), `${row.name}: a stale url is never printed`);

      if (row.proven && !row.legacy) {
        const mismatched = await forgeAsync(repo.dir, ['dash', '--permission-mode', 'auto', '--json'], env);
        assert.equal(mismatched.status, 1, `${row.name}: ${mismatched.stdout}${mismatched.stderr}`);
        assert.match(json(mismatched.stdout).error.message, /runs without --permission-mode/, `${row.name}: a mode the running dashboard was not started with`);
        const running = await forgeAsync(repo.dir, ['dash', '--json'], env);
        assert.equal(running.status, 0, `${row.name}: ${running.stderr}`);
        const name = defaultProjectName(repo.dir);
        assert.deepEqual(json(running.stdout), { url: `${row.url}/?project=${name}`, pid, running: true, project: name, added: true, permissionMode: null }, `${row.name}: dash reports the running one`);
      }

      const stop = await forgeAsync(repo.dir, ['dash', '--stop', '--json'], env);
      assert.equal(stop.status, 0, `${row.name}: ${stop.stderr}`);
      assert.deepEqual(json(stop.stdout), { stopped: row.proven, daemonReaped: false }, `${row.name}: dash --stop`);
      assert.equal(alive(pid), !row.proven, `${row.name}: ${row.proven ? 'the dashboard exited' : 'the process was not signalled'}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, `${row.name}: the record is cleared`);
    }
  } finally {
    for (const c of children) c.kill('SIGKILL');
    for (const r of repos) r.cleanup();
  }
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const recordPid = (home: string): unknown => {
  const file = machineDashboardFile(home);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).pid : undefined;
};

test("dash captures the login shell's PATH once at start, outside any job", { skip: process.platform === 'win32' }, async () => {
  const repo = setupRepo();
  const home = freshHome();
  const log = path.join(repo.dir, '..', `${path.basename(repo.dir)}-shell.log`);
  let pid: number | undefined;
  try {
    const port = await freePort();
    const shell = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'bin', 'fake-login-shell');
    const started = await forgeAsync(repo.dir, ['dash', '--dev', '--background', '--port', String(port), '--json'], { SHELL: shell, FAKE_SHELL_LOG: log, FORGE_HOME: home });
    assert.equal(started.status, 0, started.stderr);
    pid = json(started.stdout).pid as number;
    await waitFor(() => recordPid(home) === pid, { what: "the dev child's record" });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1, calls.join('\n'));
    const [cwd, args] = calls[0].split('|');
    assert.equal(cwd, fs.realpathSync(os.homedir()));
    assert.ok(args.startsWith('-lc '), args);
    const stop = await forgeAsync(repo.dir, ['dash', '--stop', '--json'], { FORGE_HOME: home });
    assert.equal(stop.status, 0, stop.stderr);
    await waitFor(() => !alive(pid!), { what: 'the dev child to exit' });
  } finally {
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {}
    fs.rmSync(log, { force: true });
    repo.cleanup();
  }
});

// Native Windows proves no record, so --stop could never stop the child there.
test('a stale record does not block dash --dev, and --stop stops the real background child', { skip: process.platform === 'win32' }, async () => {
  const repo = setupRepo();
  const home = freshHome();
  const env = { FORGE_HOME: home };
  const stale = spawnIdle(repo.dir, 'wordsAfterE');
  const stalePid = stale.pid!;
  let devPid: number | undefined;
  try {
    writeJsonAtomic(machineDashboardFile(home), { pid: stalePid, url: 'http://127.0.0.1:7999', startedAt: new Date(processStartMs(stalePid) ?? Date.now()).toISOString() });

    const port = await freePort();
    const dev = await forgeAsync(repo.dir, ['dash', '--dev', '--background', '--port', String(port), '--json'], env);
    assert.equal(dev.status, 0, dev.stderr);
    assert.ok(!`${dev.stdout}${dev.stderr}`.includes('already running'), 'a stale record does not refuse --dev');
    const started = json(dev.stdout);
    assert.equal(started.started, true);
    assert.equal(typeof started.pid, 'number');
    assert.notEqual(started.pid, stalePid);
    devPid = started.pid as number;

    await waitFor(() => recordPid(home) === devPid, { what: "the dev child's record" });
    const stop = await forgeAsync(repo.dir, ['dash', '--stop', '--json'], env);
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(json(stop.stdout), { stopped: true, daemonReaped: false });
    await waitFor(() => !alive(devPid!), { what: 'the dev child to exit' });
    assert.ok(alive(stalePid), 'the stale process was not signalled');
  } finally {
    for (const pid of [devPid, stalePid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {}
    }
    repo.cleanup();
  }
});

const status = (url: string, token: string): Promise<number> =>
  new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, agent: false, headers: { 'x-forge-token': token } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
  });

const getJson = (url: string, token: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, agent: false, headers: { 'x-forge-token': token } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${url}: ${res.statusCode} ${body}`))));
    });
    req.on('error', reject);
  });

test('dash in a second repo opens the running machine dashboard', { skip: process.platform === 'win32' }, async () => {
  const a = setupRepo();
  const b = setupRepo();
  const home = freshHome();
  const env = { FORGE_HOME: home };
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dash-outside-')));
  made.push(outside);
  let pid: number | undefined;
  try {
    const port = await freePort();
    // A login shell slower than a few seconds (its capture times out at 5 s) still gives a confirmed start.
    const shell = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'bin', 'fake-login-shell');
    const started = await forgeAsync(a.dir, ['dash', '--background', '--port', String(port), '--permission-mode', 'auto', '--json'], { ...env, SHELL: shell, FAKE_SHELL_SLEEP: '3.5' });
    assert.equal(started.status, 0, started.stderr);
    pid = json(started.stdout).pid as number;
    await waitFor(() => recordPid(home) === pid, { what: "a's dashboard record" });
    const recText = fs.readFileSync(machineDashboardFile(home), 'utf8');
    const rec = JSON.parse(recText);
    const origin = rec.url as string;
    assert.equal(rec.permissionMode, 'auto', 'the record carries the launch mode');
    // The login file holds the child's token, private; the record never does.
    const loginFile = dashboardLoginFile(home);
    const login = JSON.parse(fs.readFileSync(loginFile, 'utf8'));
    const token = login.token as string;
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.deepEqual(login, { pid, token });
    assert.equal(fs.statSync(loginFile).mode & 0o777, 0o600);
    assert.equal('token' in rec, false);
    assert.ok(!recText.includes(token), 'the record never holds the token');
    const [nameA, nameB] = [defaultProjectName(a.dir), defaultProjectName(b.dir)];
    assert.deepEqual(json(started.stdout), { url: `${origin}/?project=${nameA}#k=${token}`, pid, started: true, project: nameA, added: true, permissionMode: 'auto' });
    assert.equal(trustApproved(home, a.dir), true, 'a human ran forge dash in a: its files are approved');
    assert.equal(trustApproved(home, b.dir), false, "forge dash in a approves nothing of b's");

    // Another mode is reported, never applied: nothing is registered, approved, written or signalled.
    const index = () => fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
    const before = [index(), fs.readFileSync(machineDashboardFile(home), 'utf8')];
    const mismatched = await forgeAsync(b.dir, ['dash', '--permission-mode', 'dontAsk', '--json'], env);
    assert.equal(mismatched.status, 1, `${mismatched.stdout}${mismatched.stderr}`);
    const refusal = json(mismatched.stdout).error;
    assert.match(refusal.message, /runs with --permission-mode auto/);
    assert.match(refusal.message, /--permission-mode dontAsk was not applied/);
    assert.equal(refusal.hint, 'forge dash --stop');
    assert.deepEqual([index(), fs.readFileSync(machineDashboardFile(home), 'utf8')], before, 'the index and the record are byte-identical');
    assert.equal(trustApproved(home, b.dir), false, 'a refused launch approves nothing');
    assert.equal((await getJson(`${origin}/api/projects`, token)).machine.launchPermissionMode, 'auto', "the running server's mode is unchanged");
    assert.equal(json((await forgeAsync(b.dir, ['daemon', 'status', '--json'], env)).stdout).dashboard.permissionMode, 'auto');

    const second = await forgeAsync(b.dir, ['dash', '--json'], env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(json(second.stdout), { url: `${origin}/?project=${nameB}#k=${token}`, pid, running: true, project: nameB, added: true, permissionMode: 'auto' });
    assert.equal(trustApproved(home, b.dir), true, 'and forge dash in b approves its own');
    // Opening the running dashboard again for a registered repo approves nothing: a change since then waits for Start.
    fs.appendFileSync(path.join(b.dir, 'CLAUDE.md'), 'a change nobody reviewed\n');
    const reopened = await forgeAsync(b.dir, ['dash', '--json'], env);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.deepEqual(json(reopened.stdout), { url: `${origin}/?project=${nameB}#k=${token}`, pid, running: true, project: nameB, added: false, permissionMode: 'auto' });
    assert.equal(trustApproved(home, b.dir), false, 'a report for a registered repo approves nothing');
    const list = json((await forgeAsync(b.dir, ['project', 'list', '--json'], env)).stdout);
    assert.deepEqual(list.projects.map((p: { name: string }) => p.name).sort(), [nameA, nameB].sort());
    const dashes = execFileSync('ps', ['-A', '-ww', '-o', 'command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(`dash --foreground --port ${port}`));
    assert.equal(dashes.length, 1, dashes.join('\n'));
    assert.ok(dashes[0]!.includes('--permission-mode auto'), `the background child gets the launch mode: ${dashes[0]}`);
    await waitFor(async () => (await status(`${origin}/api/p/${nameB}/state`, token)) === 200, { what: "b's routes", timeoutMs: 5000 });

    const out = await forgeAsync(outside, ['dash', '--json'], { ...env, FORGE_ROOT: '' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(json(out.stdout), { url: `${origin}/#k=${token}`, pid, running: true, project: null, permissionMode: 'auto' });

    // forge dash url reprints the link, in a registered repo and outside one, and registers nothing.
    const indexBefore = index();
    const inB = await forgeAsync(b.dir, ['dash', 'url', '--json'], env);
    assert.equal(inB.status, 0, inB.stderr);
    assert.deepEqual(json(inB.stdout), { url: `${origin}/?project=${nameB}#k=${token}`, pid, project: nameB });
    const away = await forgeAsync(outside, ['dash', 'url', '--json'], { ...env, FORGE_ROOT: '' });
    assert.equal(away.status, 0, away.stderr);
    assert.deepEqual(json(away.stdout), { url: `${origin}/#k=${token}`, pid, project: null });
    assert.equal(index(), indexBefore, 'forge dash url changes no projects.json');

    const stopped = await forgeAsync(a.dir, ['dash', '--stop', '--json'], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(loginFile, 'utf8')), {}, '--stop empties the login file');
    const gone = await forgeAsync(a.dir, ['dash', 'url', '--json'], env);
    assert.equal(gone.status, 1, gone.stdout);
    assert.match(json(gone.stdout).error.message, /^no machine dashboard is running/);
  } finally {
    await forgeAsync(a.dir, ['dash', '--stop', '--json'], env);
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {}
    a.cleanup();
    b.cleanup();
  }
});

test('a daemon session may only ask for the running dashboard of a registered project', { skip: process.platform === 'win32' }, async () => {
  const repo = setupRepo();
  const registered = setupRepo();
  const home = freshHome();
  const server = spawnIdle(repo.dir, 'script');
  const pid = server.pid!;
  try {
    const url = 'http://127.0.0.1:7997';
    writeJsonAtomic(machineDashboardFile(home), { pid, url, startedAt: new Date(processStartMs(pid) ?? Date.now()).toISOString() });
    const daemon = (dir: string) => ({ FORGE_HOME: home, FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox', [TRUST_ENV]: trustDigest(dir) });
    const index = () => (fs.existsSync(path.join(home, 'projects.json')) ? fs.readFileSync(path.join(home, 'projects.json'), 'utf8') : null);
    const record = () => fs.readFileSync(machineDashboardFile(home), 'utf8');
    const before = [index(), record()];
    for (const args of [['dash', '--json'], ['dash', '--stop', '--json'], ['dash', '--background', '--json']]) {
      const r = await forgeAsync(repo.dir, args, daemon(repo.dir));
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(json(r.stdout).error.message, /forge dash starts, stops and registers the machine's dashboard, which a daemon session may not do/, args.join(' '));
    }
    assert.deepEqual([index(), record()], before, 'the index and the record are byte-identical');
    assert.ok(alive(pid), 'the running dashboard was not signalled');

    // The live dashboard's login: a daemon session never gets the link, from either command.
    const token = 'c'.repeat(32);
    writeJsonAtomic(dashboardLoginFile(home), { pid, token });
    addProject(home, registered.dir);
    const name = defaultProjectName(registered.dir);
    const added = index();
    const asked = await forgeAsync(registered.dir, ['dash', 'url', '--json'], daemon(registered.dir));
    assert.equal(asked.status, 1, `${asked.stdout}${asked.stderr}`);
    assert.match(json(asked.stdout).error.message, /^forge dash url prints the dashboard's login link, which a daemon session may not read/);
    assert.ok(!`${asked.stdout}${asked.stderr}`.includes(token), 'the key is never printed');
    const report = await forgeAsync(registered.dir, ['dash', '--json'], daemon(registered.dir));
    assert.equal(report.status, 0, report.stderr);
    assert.deepEqual(json(report.stdout), { url: `${url}/?project=${name}`, pid, running: true, project: name, added: false, permissionMode: null });
    assert.equal(index(), added);
    assert.equal(trustApproved(home, registered.dir), false, "a session's report approves no files");

    // A login file left by another process is no login link, even for a human.
    writeJsonAtomic(dashboardLoginFile(home), { pid: pid + 1, token });
    const stale = await forgeAsync(registered.dir, ['dash', 'url', '--json'], { FORGE_HOME: home });
    assert.equal(stale.status, 1, `${stale.stdout}${stale.stderr}`);
    assert.match(json(stale.stdout).error.message, new RegExp(`^the running dashboard \\(pid ${pid}\\) left no login link`));
    assert.equal(json(stale.stdout).error.hint, 'forge dash --stop');
  } finally {
    server.kill('SIGKILL');
    repo.cleanup();
    registered.cleanup();
  }
});
