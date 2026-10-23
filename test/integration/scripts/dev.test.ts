import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { devPlan } from '../../../scripts/dev.ts';

describe('scripts/dev.ts', () => {
  it('devPlan takes --port and --scenario', () => {
    const plain = devPlan([], {});
    assert.equal(plain.scenario, null);
    assert.deepEqual(plain.dash.args.slice(1), ['dash', '--dev']);
    assert.equal(plain.dash.env, undefined);

    assert.equal(devPlan(['--scenario', 'gates'], {}).scenario, 'gates');
    for (const argv of [
      ['--port', '7500', '--scenario', 'busy'],
      ['--scenario', 'busy', '--port', '7500'],
    ]) {
      const p = devPlan(argv, {});
      assert.equal(p.scenario, 'busy', argv.join(' '));
      assert.deepEqual(p.dash.args.slice(1), ['dash', '--dev', '--port', '7500'], argv.join(' '));
    }

    for (const argv of [['--scenario'], ['--scenario', '../x'], ['--scenario', 'a', '--scenario', 'b'], ['--port', '1', '--port', '2']]) {
      assert.throws(() => devPlan(argv, {}), { message: 'usage: npm run dev [-- --port N] [--scenario NAME]' }, argv.join(' '));
    }
  });
});
