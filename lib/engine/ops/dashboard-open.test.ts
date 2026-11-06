import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { browserArgv, clearDashboardOpen, dashboardOpenFile, openDashboard, redirectHtml, shouldOpen } from './dashboard-open.ts';

const posix = process.platform !== 'win32';

test('the open decision', () => {
  type Row = { name: string; flags: Record<string, any>; env?: NodeJS.ProcessEnv; mode?: 'human' | 'agent'; isTTY?: boolean; want: boolean | 'usage'; explicit?: boolean; note?: boolean };
  const rows: Row[] = [
    { name: '--open with --no-open', flags: { open: true, 'no-open': true }, want: 'usage' },
    { name: '--open with --service', flags: { open: true, service: true }, want: 'usage' },
    { name: '--no-open with --service', flags: { 'no-open': true, service: true }, want: 'usage' },
    { name: '--open with --stop', flags: { open: true, stop: true }, want: 'usage' },
    { name: '--no-open with --stop', flags: { 'no-open': true, stop: true }, want: 'usage' },
    { name: 'FORGE_BROWSER=none beats --open', flags: { open: true }, env: { FORGE_BROWSER: ' none ' }, want: false, explicit: true, note: true },
    { name: 'FORGE_BROWSER=none beats a terminal', flags: {}, env: { FORGE_BROWSER: 'none' }, mode: 'human', isTTY: true, want: false, explicit: false },
    { name: '--no-open', flags: { 'no-open': true }, mode: 'human', isTTY: true, want: false, explicit: true },
    { name: '--open', flags: { open: true }, want: true, explicit: true },
    { name: '--open with --dev', flags: { open: true, dev: true }, want: true, explicit: true },
    { name: 'a terminal in human mode', flags: {}, mode: 'human', isTTY: true, want: true, explicit: false },
    { name: 'agent mode', flags: {}, mode: 'agent', isTTY: true, want: false, explicit: false },
    { name: 'piped stdout', flags: {}, mode: 'human', isTTY: false, want: false, explicit: false },
    { name: '--dev in a terminal', flags: { dev: true }, mode: 'human', isTTY: true, want: false, explicit: false },
    { name: '--background in a terminal', flags: { background: true }, mode: 'human', isTTY: true, want: true, explicit: false },
  ];
  for (const r of rows) {
    const opts = { env: r.env ?? {}, mode: r.mode ?? 'agent', isTTY: r.isTTY ?? false };
    if (r.want === 'usage') {
      assert.throws(() => shouldOpen(r.flags, opts), (e: any) => e.code === 'usage' && e.exitCode === 2, r.name);
      continue;
    }
    const d = shouldOpen(r.flags, opts);
    assert.equal(d.open, r.want, r.name);
    assert.equal(d.explicit, r.explicit, r.name);
    assert.equal(typeof d.note === 'string', Boolean(r.note), r.name);
  }
});

test('the opener for each platform', () => {
  const file = '/home/u/.forge/runtime/dashboard-open.html';
  const on = (...paths: string[]) => (p: string) => paths.includes(p);
  type Row = { name: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exe?: (p: string) => boolean; want: string[] | string };
  const rows: Row[] = [
    { name: 'darwin', platform: 'darwin', env: {}, want: ['/usr/bin/open', file] },
    { name: 'linux with DISPLAY and xdg-open', platform: 'linux', env: { DISPLAY: ':0', PATH: '/usr/local/bin:/usr/bin' }, exe: on('/usr/bin/xdg-open'), want: ['/usr/bin/xdg-open', file] },
    { name: 'linux with Wayland', platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', PATH: '/usr/bin' }, exe: on('/usr/bin/xdg-open'), want: ['/usr/bin/xdg-open', file] },
    { name: 'linux without a display', platform: 'linux', env: { PATH: '/usr/bin' }, exe: on('/usr/bin/xdg-open'), want: 'no display' },
    { name: 'linux with xdg-open only in relative or empty entries', platform: 'linux', env: { DISPLAY: ':0', PATH: `bin${path.delimiter}${path.delimiter}./tools${path.delimiter}/usr/bin` }, exe: (p) => !path.isAbsolute(p), want: 'not found' },
    { name: 'linux falls back to wslview', platform: 'linux', env: { DISPLAY: ':0', PATH: '/usr/bin' }, exe: on('/usr/bin/wslview'), want: ['/usr/bin/wslview', file] },
    { name: 'win32', platform: 'win32', env: { SystemRoot: 'D:\\Win' }, want: ['D:\\Win\\System32\\rundll32.exe', 'url.dll,FileProtocolHandler', file] },
    { name: 'win32 without SystemRoot', platform: 'win32', env: {}, want: ['C:\\Windows\\System32\\rundll32.exe', 'url.dll,FileProtocolHandler', file] },
    { name: 'another platform', platform: 'freebsd', env: {}, want: 'unsupported platform' },
    { name: 'FORGE_BROWSER=none', platform: 'darwin', env: { FORGE_BROWSER: 'none' }, want: 'none' },
  ];
  for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as NodeJS.Platform[]) {
    rows.push({ name: `FORGE_BROWSER on ${platform}`, platform, env: { FORGE_BROWSER: '"/opt/my browser" --new-window' }, want: ['/opt/my browser', '--new-window', file] });
  }
  for (const r of rows) {
    const got = browserArgv(file, { platform: r.platform, env: r.env, isExecutable: r.exe ?? (() => false) });
    assert.deepEqual(got, typeof r.want === 'string' ? { reason: r.want } : { argv: r.want }, r.name);
  }
  assert.throws(() => browserArgv(file, { platform: 'darwin', env: { FORGE_BROWSER: '""' } }), /FORGE_BROWSER names no command/);
});

test('the redirect file keeps the key out of argv', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-open-'));
  try {
    const token = 'ab'.repeat(16);
    const url = `http://127.0.0.1:7400/?project=a"<b>&c'd#k=${token}`;
    const html = redirectHtml(url);
    for (const attr of html.matchAll(/(?:content|href)="([^"]*)"/g)) assert.doesNotMatch(attr[1]!, /[<>"'&](?!amp;|lt;|gt;|quot;|#39;)/, attr[0]);
    assert.ok(html.includes('a&quot;&lt;b&gt;&amp;c&#39;d'), html);
    assert.ok(!html.includes('<script'), 'no script');

    const calls: { cmd: string; args: string[]; opts: any }[] = [];
    const fake = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => child.emit('spawn'));
      return child;
    }) as unknown as typeof spawn;
    const errs: string[] = [];
    await openDashboard(home, url, { explicit: true, env: { FORGE_BROWSER: '/opt/browser --new' }, spawn: fake, stderr: (l) => errs.push(l) });
    const file = dashboardOpenFile(home);
    assert.deepEqual(errs, []);
    assert.equal(calls.length, 1);
    const argv = [calls[0]!.cmd, ...calls[0]!.args];
    assert.deepEqual(argv, ['/opt/browser', '--new', file]);
    assert.ok(argv.every((a) => !a.includes(token)), 'no argv element holds the key');
    assert.equal(calls[0]!.opts.shell, false);
    assert.equal(calls[0]!.opts.detached, true);
    assert.equal(fs.readFileSync(file, 'utf8'), html);
    if (posix) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }

    // A failed spawn is one stderr line, never a throw.
    const failing = ((): EventEmitter => {
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => child.emit('error', new Error('spawn /nope ENOENT')));
      return child;
    }) as unknown as typeof spawn;
    await openDashboard(home, url, { explicit: false, env: { FORGE_BROWSER: '/nope' }, spawn: failing, stderr: (l) => errs.push(l) });
    assert.deepEqual(errs, ['could not open a browser (spawn /nope ENOENT); open the login link above, or run forge dash url\n']);
    // An implicit open on a headless box stays quiet; an explicit one says why.
    errs.length = 0;
    await openDashboard(home, url, { explicit: false, env: {}, platform: 'linux', spawn: failing, stderr: (l) => errs.push(l) });
    assert.deepEqual(errs, []);
    await openDashboard(home, url, { explicit: true, env: {}, platform: 'linux', spawn: failing, stderr: (l) => errs.push(l) });
    assert.deepEqual(errs, ['could not open a browser (no display); open the login link above, or run forge dash url\n']);

    clearDashboardOpen(home);
    assert.equal(fs.existsSync(file), false);
    clearDashboardOpen(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
