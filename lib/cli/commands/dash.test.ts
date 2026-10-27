// `forge dash --permission-mode`, the run's launch mode: the three modes only, never set from a daemon session, and
// forwarded to the --background child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeError } from '#core/errors.ts';
import { backgroundArgs, launchPermissionMode } from './dash.ts';

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
