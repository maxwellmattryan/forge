// `forge release` routing through the spawned CLI: plan's --bump, run's --dry-run, and the daemon refusal that
// --dry-run is the one exception to. The engine's behaviour is covered in lib/engine/release/*.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeSync, initScriptProject, repoTemplate } from '../../helpers.ts';
import { TRUST_ENV, trustDigest } from '#core/config/trust.ts';
import { OFFICE_SCOPE } from '#api/constants.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const project = repoTemplate(initScriptProject);

test('release plan --bump and release run --dry-run', POSIX, () => {
  const r = project();
  try {
    const plan = forgeSync(r.dir, ['release', 'plan', '--bump', 'minor']);
    assert.equal(plan.status, 0, plan.stderr);
    const planned = JSON.parse(plan.stdout);
    assert.equal(planned.bumps[0].bump, 'minor');
    assert.equal(planned.bumps[0].to, '1.1.0');

    const huge = forgeSync(r.dir, ['release', 'plan', '--bump', 'huge']);
    assert.equal(huge.status, 2, huge.stderr);
    assert.match(huge.stderr + huge.stdout, /--bump must be patch, minor or major/);

    const daemon = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: OFFICE_SCOPE, [TRUST_ENV]: trustDigest(r.dir) };
    for (const env of [{}, daemon]) {
      const dry = forgeSync(r.dir, ['release', 'run', '--dry-run'], env);
      assert.equal(dry.status, 0, dry.stderr);
      const out = JSON.parse(dry.stdout);
      assert.equal(out.dryRun, true);
      assert.deepEqual(out.steps.map((s: { id: string }) => s.id.split('/')[1]), ['preflight', 'start', 'merge', 'tag']);
    }
    const refused = forgeSync(r.dir, ['release', 'run'], daemon);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr + refused.stdout, /a daemon session may not do/);
  } finally {
    r.cleanup();
  }
});
