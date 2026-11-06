// `forge dash --permission-mode`, the run's launch mode: the three modes only, never set from a daemon session, and
// forwarded to the --background child; and the login link, whose key rides only in the fragment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeError } from '#core/errors.ts';
import { backgroundArgs, launchPermissionMode, loginUrl, shouldOpen } from './dash.ts';

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
      assert.throws(() => shouldOpen(r.flags, opts), (e: unknown) => e instanceof ForgeError && e.code === 'usage' && e.exitCode === 2, r.name);
      continue;
    }
    const d = shouldOpen(r.flags, opts);
    assert.equal(d.open, r.want, r.name);
    assert.equal(d.explicit, r.explicit, r.name);
    assert.equal(typeof d.note === 'string', Boolean(r.note), r.name);
  }
});

test('--permission-mode takes the three modes, and never from a daemon session', () => {
  assert.equal(launchPermissionMode({}, {}), null);
  for (const mode of ['default', 'auto', 'dontAsk']) assert.equal(launchPermissionMode({ 'permission-mode': mode }, {}), mode);
  for (const v of ['bypassPermissions', 'acceptEdits', 'plan', true]) {
    assert.throws(
      () => launchPermissionMode({ 'permission-mode': v }, {}),
      (e: unknown) => e instanceof ForgeError && e.code === 'usage' && /--permission-mode must be one of default, auto, dontAsk/.test(e.message),
      String(v),
    );
  }
  for (const mode of ['default', 'auto', 'dontAsk', 'bypassPermissions']) {
    assert.throws(() => launchPermissionMode({ 'permission-mode': mode }, { FORGE_DAEMON: '1' }), /which a daemon session may not do/, mode);
  }
});

test('the login link carries the key only in its fragment', () => {
  const o = 'http://127.0.0.1:7400';
  const k = 'a'.repeat(32);
  assert.equal(loginUrl(o, null, null), o);
  assert.equal(loginUrl(o, 'p', null), `${o}/?project=p`);
  assert.equal(loginUrl(o, null, k), `${o}/#k=${k}`);
  assert.equal(loginUrl(o, 'p', k), `${o}/?project=p#k=${k}`);
});

test('the background child gets the launch mode and --quiet', () => {
  const saved = process.env.FORGE_DAEMON;
  delete process.env.FORGE_DAEMON;
  try {
    assert.deepEqual(backgroundArgs(7402, { 'permission-mode': 'auto' }), ['dash', '--foreground', '--port', '7402', '--permission-mode', 'auto', '--quiet']);
    assert.deepEqual(backgroundArgs(7402, {}), ['dash', '--foreground', '--port', '7402', '--quiet']);
  } finally {
    if (saved !== undefined) process.env.FORGE_DAEMON = saved;
  }
});
