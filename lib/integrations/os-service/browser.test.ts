// The opener for each platform, by absolute path or FORGE_BROWSER, and the redirect file that keeps the login key out
// of every argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { browserArgv, openViaRedirect, redirectHtml } from './browser.ts';

const posix = process.platform !== 'win32';

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

/** A spawn that records its calls and answers with `event` on the next tick. */
function fakeSpawn(calls: { cmd: string; args: string[]; opts: any }[], event: 'spawn' | Error): typeof spawn {
  return ((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    setImmediate(() => (event === 'spawn' ? child.emit('spawn') : child.emit('error', event)));
    return child;
  }) as unknown as typeof spawn;
}

test('the redirect file keeps the key out of argv', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-open-'));
  try {
    const token = 'ab'.repeat(16);
    const url = `http://127.0.0.1:7400/?project=a"<b>&c'd#k=${token}`;
    const html = redirectHtml(url);
    for (const attr of html.matchAll(/(?:content|href)="([^"]*)"/g)) assert.doesNotMatch(attr[1]!, /[<>'&](?!amp;|lt;|gt;|quot;|#39;)/, attr[0]);
    assert.ok(html.includes('a&quot;&lt;b&gt;&amp;c&#39;d'), html);
    assert.ok(!html.includes('<script'), 'no script');

    const file = path.join(home, 'runtime', 'dashboard-open.html');
    const calls: { cmd: string; args: string[]; opts: any }[] = [];
    const opened = await openViaRedirect(file, url, { spawn: fakeSpawn(calls, 'spawn'), env: { FORGE_BROWSER: '/opt/browser --new' }, platform: 'linux' });
    assert.equal(opened, null);
    assert.equal(calls.length, 1);
    const argv = [calls[0]!.cmd, ...calls[0]!.args];
    assert.deepEqual(argv, ['/opt/browser', '--new', file]);
    assert.ok(argv.every((a) => !a.includes(token)), 'no argv element holds the key');
    assert.equal(calls[0]!.opts.shell, false);
    assert.equal(calls[0]!.opts.detached, true);
    assert.equal(calls[0]!.opts.stdio, 'ignore');
    assert.equal(fs.readFileSync(file, 'utf8'), html);
    if (posix) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }

    // A failed spawn resolves with its reason, never a rejection; no display or opener is headless.
    const none: { cmd: string; args: string[]; opts: any }[] = [];
    assert.deepEqual(await openViaRedirect(file, url, { spawn: fakeSpawn(none, new Error('spawn /nope ENOENT')), env: { FORGE_BROWSER: '/nope' }, platform: 'linux' }), { reason: 'spawn /nope ENOENT', headless: false });
    assert.deepEqual(await openViaRedirect(file, url, { spawn: fakeSpawn(none, 'spawn'), env: {}, platform: 'linux' }), { reason: 'no display', headless: true });
    assert.deepEqual(await openViaRedirect(file, url, { spawn: fakeSpawn(none, 'spawn'), env: { FORGE_BROWSER: 'none' }, platform: 'darwin' }), null);
    assert.equal(none.length, 1, 'only the FORGE_BROWSER=/nope run reached spawn');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
