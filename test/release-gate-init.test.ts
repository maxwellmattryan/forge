// `forge init write` seeds the release gate (docs/CONFIG.md "Release gate") when a dependency
// resolves to git-ref or canary, never over an existing file, and the workflow it seeds.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_GATE_RULE, RELEASE_GATE_WARNING, initWrite } from '../lib/commands/init.ts';
import { matchPolicy } from '../lib/protected.ts';
import type { ProtectedRule } from '../lib/types.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import * as yaml from '../lib/yaml.ts';
import { tempRepo } from './helpers.ts';

const SCRIPT = path.join('.forge', 'ci', 'release-gate.mjs');
const WORKFLOW = path.join('.github', 'workflows', 'forge-release-gate.yml');
const TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'release-gate');
const base = { tracker: { kind: 'none' }, pr: { enabled: false } };
const member = (interim: string) => ({ repos: [{ name: 'lib', remote: 'git@github.com:acme/lib.git', defaultBranch: 'main', release: { interim } }] });

describe('release gate seeding', { concurrency: 4 }, () => {
  test('seeds the gate for git-ref and canary only', () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ['root git-ref', { release: { interim: 'git-ref' } }, true],
      ['member canary', member('canary'), true],
      ['root canary', { release: { interim: 'canary' } }, true],
      ['root local', { release: { interim: 'local' } }, false],
      ['member sequential', { release: { interim: 'local' }, ...member('sequential') }, false],
      ['nothing set', {}, false],
    ];
    for (const [name, answers, seeded] of cases) {
      const r = tempRepo();
      try {
        const out = initWrite(r.dir, { ...base, ...answers }, false);
        assert.equal(fs.existsSync(path.join(r.dir, SCRIPT)), seeded, `${name}: script`);
        assert.equal(fs.existsSync(path.join(r.dir, WORKFLOW)), seeded, `${name}: workflow`);
        assert.equal(out.written.includes(SCRIPT), seeded, `${name}: written`);
        assert.equal(out.written.includes(WORKFLOW), seeded, `${name}: written`);
        assert.equal(out.warnings.filter((w) => w === RELEASE_GATE_WARNING).length, seeded ? 1 : 0, `${name}: warning`);
        if (seeded) {
          assert.ok(fs.readFileSync(path.join(r.dir, SCRIPT)).equals(fs.readFileSync(path.join(TEMPLATE, 'release-gate.mjs'))), `${name}: byte-identical`);
          assert.ok(fs.readFileSync(path.join(r.dir, WORKFLOW)).equals(fs.readFileSync(path.join(TEMPLATE, 'forge-release-gate.yml'))));
        }
      } finally {
        r.cleanup();
      }
    }
    assert.equal(RELEASE_GATE_WARNING, 'seeded the release gate: commit .forge/ci/release-gate.mjs and .github/workflows/forge-release-gate.yml, then make the "release gate" check required in branch protection (docs/CONFIG.md "Release gate")');
  });

  test('never overwrites a seeded file', () => {
    const r = tempRepo();
    try {
      fs.mkdirSync(path.join(r.dir, '.forge', 'ci'), { recursive: true });
      fs.writeFileSync(path.join(r.dir, SCRIPT), '// mine\n');
      const first = initWrite(r.dir, { ...base, release: { interim: 'git-ref' } }, false);
      assert.equal(fs.readFileSync(path.join(r.dir, SCRIPT), 'utf8'), '// mine\n');
      assert.equal(first.written.includes(SCRIPT), false);
      assert.equal(first.written.includes(WORKFLOW), true);
      assert.ok(first.warnings.includes(RELEASE_GATE_WARNING), 'one of the two was written');
      fs.writeFileSync(path.join(r.dir, WORKFLOW), 'name: mine\n');
      const second = initWrite(r.dir, { ...base, release: { interim: 'git-ref' } }, false);
      assert.equal(fs.readFileSync(path.join(r.dir, WORKFLOW), 'utf8'), 'name: mine\n');
      assert.equal(second.written.includes(SCRIPT) || second.written.includes(WORKFLOW), false);
      assert.equal(second.warnings.includes(RELEASE_GATE_WARNING), false, 'nothing seeded, no warning');
    } finally {
      r.cleanup();
    }
  });

  test('an older protectedPaths list gains the gate refusal when the gate is seeded', () => {
    const old: ProtectedRule[] = [
      { paths: ['.github/workflows/**'], action: 'escalate', reason: 'CI/CD configuration' },
      { paths: ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" },
    ];
    const rules = (dir: string) => (yaml.parse(fs.readFileSync(path.join(dir, '.forge', 'config.yml'), 'utf8')) as any).policy.protectedPaths;
    const r = tempRepo();
    try {
      initWrite(r.dir, { ...base, policy: { protectedPaths: old } }, false);
      assert.deepEqual(rules(r.dir), old, 'no gate seeded: the list is left alone');
      assert.equal(matchPolicy('.forge/ci/release-gate.mjs', rules(r.dir)), null);
      initWrite(r.dir, { release: { interim: 'git-ref' } }, false);
      const after = rules(r.dir);
      assert.deepEqual(after, [...old, { ...RELEASE_GATE_RULE, paths: ['.forge/ci/**'] }]);
      assert.equal(matchPolicy('.forge/ci/release-gate.mjs', after)?.action, 'refuse');
      initWrite(r.dir, { release: { interim: 'git-ref' } }, false);
      assert.deepEqual(rules(r.dir), after, 'appended once');
    } finally {
      r.cleanup();
    }
  });

  test('a rule that already refuses the script, or only escalates it, is respected or topped up', () => {
    const cases: [string, any[], boolean][] = [
      ['refused by a broader glob', [{ paths: ['.forge/**'], action: 'refuse', reason: 'mine' }], false],
      ['refused by the default', [{ paths: ['.forge/ci/**'], action: 'refuse', reason: 'mine' }], false],
      ['only escalated', [{ paths: ['.forge/ci/**'], action: 'escalate', reason: 'mine' }], true],
      ['an empty list', [], true],
    ];
    for (const [name, list, appended] of cases) {
      const r = tempRepo();
      try {
        initWrite(r.dir, { ...base, policy: { protectedPaths: list }, release: { interim: 'canary' } }, false);
        const got = (yaml.parse(fs.readFileSync(path.join(r.dir, '.forge', 'config.yml'), 'utf8')) as any).policy.protectedPaths;
        assert.deepEqual(got, appended ? [...list, { ...RELEASE_GATE_RULE, paths: ['.forge/ci/**'] }] : list, name);
        assert.equal(matchPolicy('.forge/ci/release-gate.mjs', got)?.action, 'refuse', name);
      } finally {
        r.cleanup();
      }
    }
  });

  // The workflow init writes into a consumer repo: read-only, pinned, no stored credentials, no install.
  test('the seeded workflow runs the script with read-only permissions', () => {
    const r = tempRepo();
    try {
      initWrite(r.dir, { ...base, release: { interim: 'canary' } }, false);
      const wfRaw = fs.readFileSync(path.join(r.dir, WORKFLOW), 'utf8');
      const wf: any = yaml.parse(wfRaw);
      assert.deepEqual(wf.permissions, { contents: 'read' });
      const steps = Object.values<any>(wf.jobs).flatMap((j) => {
        assert.equal(j.permissions, undefined, 'no job widens the workflow permissions');
        return j.steps;
      });
      for (const s of steps.filter((x: any) => x.uses)) assert.match(s.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, 'pinned to a commit');
      const checkout = steps.find((s: any) => String(s.uses).startsWith('actions/checkout@'));
      assert.deepEqual(checkout.with, { 'persist-credentials': false });
      assert.ok(steps.some((s: any) => s.run === 'node .forge/ci/release-gate.mjs'), 'runs the seeded script');
      assert.ok(!/setup-node|npm |install/.test(wfRaw.replace(/^#.*$/gm, '')), 'no setup and no install');
    } finally {
      r.cleanup();
    }
  });
});
