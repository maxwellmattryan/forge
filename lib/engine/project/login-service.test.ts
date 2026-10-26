// The login service over temp homes and a recording runner: what install, uninstall and status write
// and run on each platform, the environment a unit carries, the doctor row and the uptime record.
// No real launchctl or systemctl ever runs, and nothing touches the real home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { LAUNCHD_LABEL, readLaunchAgentProgram } from '#integrations/os-service/launchd.ts';
import { SYSTEMD_UNIT, readSystemdProgram } from '#integrations/os-service/systemd.ts';
import type { DashboardProbe } from '../ops/dashboard-record.ts';
import { installService, readUptime, serviceCheck, serviceStatus, serviceUnit, uninstallService, uptimeFile, writeUptime, type ServiceOptions } from './login-service.ts';

const POSIX = process.platform !== 'win32';
const DASH_PID = 424242;
const STARTED = Date.parse('2026-10-26T08:00:00.000Z');

type Call = [string, ...string[]];

/** A recording runner: each call answered by `reply` (ok with empty output by default). */
function recorder(reply: (argv: string[]) => { ok?: boolean; stdout?: string; stderr?: string } = () => ({})) {
  const calls: Call[] = [];
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const r = reply([file, ...args]);
    const ok = r.ok ?? true;
    return { ok, status: ok ? 0 : 5, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, run };
}

/** A probe that proves only DASH_PID, running `command`. */
const probeFor = (command: string | null): DashboardProbe => ({ platform: 'darwin', alive: (pid) => pid === DASH_PID && command !== null, startMs: () => STARTED, command: () => command });

/** Temp user home and FORGE_HOME, removed after the test. */
function scratch(t: { after(fn: () => void): void }, platform: NodeJS.Platform, extra: Partial<ServiceOptions> = {}) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-login-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const userHome = path.join(top, 'home');
  fs.mkdirSync(userHome);
  const r = recorder();
  const opts: ServiceOptions = {
    platform,
    userHome,
    forgeHome: path.join(top, 'fh'),
    env: { PATH: '/usr/bin:/bin', HOME: userHome },
    execPath: '/opt/node/bin/node',
    pluginRoot: path.join(top, 'plugin'),
    uid: 501,
    run: r.run,
    probe: probeFor(null),
    ...extra,
  };
  return { top, opts, calls: r.calls };
}

/** Writes a machine dashboard record for DASH_PID, which probeFor proves. */
function dashboardRecord(forgeHome: string): void {
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'dashboard.json'), JSON.stringify({ pid: DASH_PID, url: 'http://127.0.0.1:7400', startedAt: new Date(STARTED).toISOString() }));
}

const plistOf = (home: string) => path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

test('install writes and loads the LaunchAgent', (t) => {
  const { opts, calls } = scratch(t, 'darwin');
  const file = plistOf(opts.userHome);
  const log = path.join(opts.forgeHome, 'runtime', 'service.log');
  const r = installService(opts);
  assert.deepEqual(r, { installed: true, manager: 'launchd', file, log, loaded: true, replaced: false });
  assert.deepEqual(readLaunchAgentProgram(fs.readFileSync(file, 'utf8')), [opts.execPath, path.join(opts.pluginRoot, 'bin', 'forge'), 'dash', '--service']);
  assert.ok(fs.readFileSync(file, 'utf8').includes(`<string>${log}</string>`));
  if (POSIX) {
    assert.equal(fs.statSync(path.join(opts.forgeHome, 'runtime')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
    ['launchctl', 'bootstrap', 'gui/501', file],
  ]);
  assert.equal(installService(opts).replaced, true, 'a second install replaces its own file');

  // A failing bootstrap keeps the file and reports the first line of its output.
  const failing = recorder((argv) => (argv[1] === 'bootstrap' ? { ok: false, stderr: '\nBootstrap failed: 5: Input/output error\nmore\n' } : {}));
  const bad = installService({ ...opts, run: failing.run });
  assert.deepEqual([bad.loaded, bad.error, fs.existsSync(file)], [false, 'Bootstrap failed: 5: Input/output error', true]);
});

test('install says when a dashboard started by hand is running', (t) => {
  const { opts } = scratch(t, 'darwin', { probe: probeFor('node /x/bin/forge dash --foreground --port 7400') });
  dashboardRecord(opts.forgeHome);
  assert.match(installService(opts).note ?? '', /^a dashboard you started \(pid 424242\) is running, so the service takes over at the next login, or after forge dash --stop and forge service install$/);
  // The service's own dashboard needs no note.
  assert.equal('note' in installService({ ...opts, probe: probeFor('node /x/bin/forge dash --service') }), false);
});

test('install writes and enables the systemd user unit', (t) => {
  const xdg = scratch(t, 'linux');
  const config = path.join(xdg.top, 'xdg');
  const r = installService({ ...xdg.opts, env: { ...xdg.opts.env, XDG_CONFIG_HOME: config } });
  assert.equal(r.file, path.join(config, 'systemd', 'user', SYSTEMD_UNIT));
  assert.deepEqual(readSystemdProgram(fs.readFileSync(r.file, 'utf8')), [xdg.opts.execPath, path.join(xdg.opts.pluginRoot, 'bin', 'forge'), 'dash', '--service']);
  assert.deepEqual(xdg.calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
  ]);

  const plain = scratch(t, 'linux');
  const file = path.join(plain.opts.userHome, '.config', 'systemd', 'user', SYSTEMD_UNIT);
  assert.deepEqual(installService(plain.opts), { installed: true, manager: 'systemd', file, log: path.join(plain.opts.forgeHome, 'runtime', 'service.log'), loaded: true, replaced: false });
  plain.calls.length = 0;
  // A reinstall restarts a running service on the new unit.
  assert.equal(installService(plain.opts).replaced, true);
  assert.deepEqual(plain.calls.at(-1), ['systemctl', '--user', 'try-restart', SYSTEMD_UNIT]);
});

test('the unit carries only the allowlisted environment', (t) => {
  const hostile = {
    GH_TOKEN: 'g',
    GITHUB_TOKEN: 'g',
    ANTHROPIC_API_KEY: 'a',
    OPENAI_API_KEY: 'o',
    AWS_SECRET_ACCESS_KEY: 's',
    NPM_TOKEN: 'n',
    CORP_SESSION_BLOB: 'c',
    NODE_OPTIONS: '--require /tmp/x.js',
    FORGE_DAEMON: '1',
    FORGE_COMMAND_PATH: '/evil/bin',
    EDITOR: 'vim',
  };
  const env = { ...hostile, PATH: 'relative::/usr/bin:./bin:/bin', HOME: '/Users/me', USER: 'me', LOGNAME: 'me', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TZ: 'UTC', TMPDIR: '/tmp/me', FORGE_HOME: 'rel/fh', XDG_CONFIG_HOME: '/x' };
  const { opts } = scratch(t, 'darwin', { env });
  const unit = serviceUnit(opts);
  assert.deepEqual(unit.env, {
    FORGE_HOME: path.resolve('rel/fh'),
    HOME: '/Users/me',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
    LOGNAME: 'me',
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    TMPDIR: '/tmp/me',
    TZ: 'UTC',
    USER: 'me',
  });
  for (const name of Object.keys(unit.env)) assert.ok(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TMPDIR', 'FORGE_HOME'].includes(name) || name.startsWith('LC_'), name);

  // A control character refuses, naming the variable and never its value, and writes and runs nothing.
  const rows: [string, Partial<ServiceOptions>, RegExp][] = [
    ['PATH', { env: { PATH: '/usr/bin\n<key>X</key>' } }, /^PATH holds a control character/],
    ['LANG', { env: { LANG: 'C\u0007' } }, /^LANG holds a control character/],
    ['plugin root', { pluginRoot: '/opt/forge\n/evil' }, /^the plugin root holds a control character/],
    ['execPath', { execPath: '/opt/node\r' }, /^node's path \(process.execPath\) holds a control character/],
  ];
  for (const [label, extra, want] of rows) {
    const s = scratch(t, 'darwin', extra);
    assert.throws(
      () => installService(s.opts),
      (e: unknown) => e instanceof ForgeError && want.test(e.message) && !e.message.includes('<key>') && !e.message.includes('/evil'),
      label,
    );
    assert.deepEqual([s.calls, fs.readdirSync(s.opts.userHome), fs.existsSync(s.opts.forgeHome)], [[], [], false], label);
  }
});

test('uninstall removes exactly the unit file', (t) => {
  const { opts, calls } = scratch(t, 'darwin');
  assert.deepEqual(uninstallService(opts), { manager: 'launchd', file: plistOf(opts.userHome), removed: false });
  assert.deepEqual(calls, [], 'no file: nothing runs');

  const r = installService(opts);
  const sibling = path.join(path.dirname(r.file), 'com.example.other.plist');
  fs.writeFileSync(sibling, 'x');
  fs.writeFileSync(r.log, 'log\n');
  calls.length = 0;
  assert.equal(uninstallService(opts).removed, true);
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]]);
  assert.deepEqual([fs.existsSync(r.file), fs.existsSync(sibling), fs.readFileSync(r.log, 'utf8')], [false, true, 'log\n']);

  const linux = scratch(t, 'linux');
  const unit = installService(linux.opts).file;
  linux.calls.length = 0;
  assert.equal(uninstallService(linux.opts).removed, true);
  assert.deepEqual(linux.calls, [
    ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
  assert.equal(fs.existsSync(unit), false);

  if (POSIX) {
    // A link at the unit path is removed itself; its target stays.
    const target = path.join(opts.userHome, 'precious.plist');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, r.file);
    assert.equal(uninstallService(opts).removed, true);
    assert.deepEqual([fs.lstatSync(r.file, { throwIfNoEntry: false }), fs.readFileSync(target, 'utf8')], [undefined, 'keep']);
    // And install renames over a planted link, never writing through it.
    fs.symlinkSync(target, r.file);
    installService(opts);
    assert.deepEqual([fs.lstatSync(r.file).isSymbolicLink(), fs.readFileSync(target, 'utf8')], [false, 'keep']);
  }
});

test('status runs nothing until a unit is installed', (t) => {
  const { opts, calls } = scratch(t, 'darwin');
  const none = serviceStatus(opts);
  assert.deepEqual(none, { platform: 'darwin', supported: true, manager: 'launchd', file: plistOf(opts.userHome), installed: false, loaded: null, current: null, log: path.join(opts.forgeHome, 'runtime', 'service.log') });
  assert.deepEqual(calls, []);

  installService(opts);
  calls.length = 0;
  assert.deepEqual([serviceStatus(opts).loaded, serviceStatus(opts).current], [true, true]);
  assert.deepEqual(calls[0], ['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]);
  const unloaded = recorder(() => ({ ok: false }));
  assert.equal(serviceStatus({ ...opts, run: unloaded.run }).loaded, false);
  assert.equal(serviceStatus({ ...opts, execPath: '/usr/local/bin/node' }).current, false, 'another node');
  assert.equal(serviceStatus({ ...opts, pluginRoot: path.join(opts.userHome, 'other-forge') }).current, false, 'another bin/forge');

  const linux = scratch(t, 'linux');
  installService(linux.opts);
  const active = (stdout: string) => recorder(() => ({ ok: stdout === 'active\n', stdout })).run;
  assert.equal(serviceStatus({ ...linux.opts, run: active('active\n') }).loaded, true);
  assert.equal(serviceStatus({ ...linux.opts, run: active('inactive\n') }).loaded, false);
});

test('unsupported platforms write and run nothing', (t) => {
  for (const platform of ['win32', 'freebsd'] as const) {
    const { opts, calls } = scratch(t, platform);
    const msg = new RegExp(`forge service is not supported on ${platform} yet`);
    assert.throws(() => installService(opts), msg, platform);
    assert.throws(() => uninstallService(opts), msg, platform);
    assert.equal(serviceStatus(opts).supported, false, platform);
    assert.deepEqual([calls, fs.readdirSync(opts.userHome), fs.existsSync(opts.forgeHome)], [[], [], false], platform);
  }
});

test('the service doctor row', (t) => {
  const restart = { at: '2026-10-26T08:00:05.000Z', pid: DASH_PID, projects: [{ name: 'alpha', jobs: 2, office: 1, mandates: 1 }, { name: 'beta', jobs: 0, office: 0, mandates: 1 }] };
  const held = { pid: DASH_PID, held: true, since: '2026-10-26T08:00:01.000Z', projects: ['alpha', 'beta'], error: null, at: '2026-10-26T08:00:01.000Z' };
  const service = 'node /x/bin/forge dash --service';
  type Row = { name: string; platform?: NodeJS.Platform; install?: boolean; status?: Partial<ServiceOptions>; probe?: string | null; uptime?: Parameters<typeof writeUptime>[1]; bundle?: boolean; want: (o: ServiceOptions) => string; warn?: boolean };
  const loaded = (o: ServiceOptions) => `installed and loaded (${plistOf(o.userHome)}); log ${path.join(o.forgeHome, 'runtime', 'service.log')}`;
  const rows: Row[] = [
    { name: 'unsupported', platform: 'win32', want: () => 'not supported on win32 yet' },
    { name: 'not installed', want: () => 'not installed (forge service install starts the dashboard at login); dashboard not running; no restart recorded' },
    { name: 'loaded and current, held', install: true, probe: service, uptime: { keepAwake: held, restart }, want: (o) => `${loaded(o)}; sleep assertion held for alpha, beta; last restart ${restart.at}: resumed alpha` },
    { name: 'in a support bundle, names counted', install: true, probe: service, uptime: { keepAwake: held, restart }, bundle: true, want: (o) => `${loaded(o)}; sleep assertion held for 2 projects; last restart ${restart.at}: resumed 1 project` },
    {
      name: 'not loaded',
      install: true,
      status: { run: recorder(() => ({ ok: false })).run },
      warn: true,
      want: (o) => `installed but not loaded (${plistOf(o.userHome)}): log in again or run forge service install; dashboard not running; no restart recorded`,
    },
    { name: 'another node', install: true, status: { execPath: '/usr/local/bin/node' }, warn: true, want: (o) => `${plistOf(o.userHome)} runs another Forge or node: run forge service install again; dashboard not running; no restart recorded` },
    { name: "a record from another dashboard's pid", install: true, probe: service, uptime: { keepAwake: { ...held, pid: 777 } }, want: (o) => `${loaded(o)}; sleep assertion not held; no restart recorded` },
    { name: 'a record while no dashboard runs', install: true, uptime: { keepAwake: held }, want: (o) => `${loaded(o)}; dashboard not running; no restart recorded` },
    {
      name: 'failed',
      install: true,
      probe: service,
      uptime: { keepAwake: { ...held, held: false, since: null, error: 'caffeinate exited with code 1' } },
      warn: true,
      want: (o) => `${loaded(o)}; sleep assertion failed: caffeinate exited with code 1; no restart recorded`,
    },
    { name: 'not held', install: true, probe: service, uptime: { keepAwake: { ...held, held: false, since: null, projects: [] }, restart: { ...restart, projects: [restart.projects[1]!] } }, want: (o) => `${loaded(o)}; sleep assertion not held; last restart ${restart.at}: nothing in flight` },
  ];
  for (const row of rows) {
    const { opts } = scratch(t, row.platform ?? 'darwin', { probe: probeFor(row.probe ?? null) });
    if (row.install) installService(opts);
    if (row.probe) dashboardRecord(opts.forgeHome);
    if (row.uptime) writeUptime(opts.forgeHome, row.uptime);
    const check = serviceCheck({ ...opts, ...row.status }, { bundle: row.bundle });
    assert.deepEqual(check, { name: 'service', ok: true, detail: row.want(opts), ...(row.warn ? { warn: true } : {}) }, row.name);
  }
});

test('a malformed uptime record reads as empty, and a bad entry is dropped', (t) => {
  const { opts } = scratch(t, 'darwin');
  const empty = { v: 1, keepAwake: null, restart: null };
  assert.deepEqual(readUptime(opts.forgeHome), empty, 'no file');
  writeUptime(opts.forgeHome, {});
  if (POSIX) assert.equal(fs.statSync(uptimeFile(opts.forgeHome)).mode & 0o777, 0o600);
  for (const text of ['not json', '[]', '{"v":2}', JSON.stringify({ v: 1, keepAwake: { pid: 'x' }, restart: { at: 'never', pid: 5, projects: [] } })]) {
    fs.writeFileSync(uptimeFile(opts.forgeHome), text);
    assert.deepEqual(readUptime(opts.forgeHome), empty, text);
  }
  const restart = { at: '2026-10-26T08:00:00.000Z', pid: 5, projects: [{ name: 'ok', jobs: 1, office: 0, mandates: 0 }, { name: '../evil', jobs: 1, office: 0, mandates: 0 }, { name: 'big', jobs: 1e9, office: 0, mandates: 0 }] };
  const keepAwake = { pid: 5, held: false, since: null, projects: ['ok', 'Bad Name'], error: 'line one\nline two', at: '2026-10-26T08:00:00.000Z' };
  fs.writeFileSync(uptimeFile(opts.forgeHome), JSON.stringify({ v: 1, keepAwake, restart }));
  const read = readUptime(opts.forgeHome);
  assert.deepEqual(read.restart?.projects, [{ name: 'ok', jobs: 1, office: 0, mandates: 0 }]);
  assert.deepEqual([read.keepAwake?.projects, read.keepAwake?.error], [['ok'], 'line one line two']);
});
