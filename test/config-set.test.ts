import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { FIELDS } from '../lib/config-fields.ts';
import { COMPLEXITIES, EFFORT_ROLES, EFFORTS } from '../lib/schema.ts';
import { setConfigValue } from '../lib/config-set.ts';
import { getPath } from '../lib/util.ts';
import { setIn } from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'config-commented.yml'), 'utf8');

/** A scratch repo with the commented fixture as its config (or none). */
function scratch(text: string | null = FIXTURE) {
  const repo = tempRepo();
  const file = path.join(repo.dir, '.forge', 'config.yml');
  if (text !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const cli = async (env: Record<string, string>, ...args: string[]) => {
    const r = await forgeAsync(repo.dir, args, env);
    return r.status === 0 ? { code: 0, out: r.stdout.trim(), err: '' } : { code: r.status as number, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const forge = (...args: string[]) => cli({}, ...args);
  return { repo, file, cli, forge, read: () => fs.readFileSync(file, 'utf8') };
}

// Each test has its own scratch repo, so they run side by side.
describe('forge config set and get', { concurrency: 4 }, () => {
  test('set rewrites one value and keeps comments and key order', async () => {
    const s = scratch();
    try {
      const r = await s.forge('config', 'set', 'pipeline.maxRounds', '5');
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, '{"ok":true,"key":"pipeline.maxRounds","value":5,"previous":3,"changed":true}');
      const before = FIXTURE.split('\n');
      const after = s.read().split('\n');
      assert.equal(after.length, before.length, 'no line added or removed');
      const diff = after.map((l, i) => [before[i], l]).filter(([a, b]) => a !== b);
      assert.deepEqual(diff, [['  maxRounds: 3              # build→review rounds', '  maxRounds: 5              # build→review rounds']]);
    } finally {
      s.repo.cleanup();
    }
  });

  test('set validates values against the field schema', async () => {
    const s = scratch();
    try {
      const cases: [string, string][] = [
        ['pipeline.maxRounds', '0'],
        ['pipeline.maxRounds', 'x'],
        ['pipeline.plan', 'sometimes'],
        ['runtime.diversity', 'yes'],
        ['review.blockOn', '[major]'],
        ['review.blockOn', '[blocker, huge]'],
        ['review.blockOn', '[blocker]'],
        ['review.blockOn', '[]'],
        ['review.blockOn', '[major, minor]'],
        ['dashboard.port', '80'],
        ['tracker.github.ready.labels', '["--repo=x"]'],
        ['runtime.models.builder', 'opus; rm -rf /'],
        ['runtime.models.builder', 'a'.repeat(201)],
        ['daemon.idleStopMinutes', '0'],
        ['pipeline.maxRounds', '2.5'],
        ['tracker.github.labels.prefix', '-x:'],
        ['tracker.github.labels.prefix', 'b'],
        ['tracker.github.labels.prefix', 'priority'],
        ['tracker.github.ready.milestone', 'a\u0001b'],
        ['tracker.github.ready.milestone', 'v1\u202Egnp.exe'],
        ['tracker.github.ready.assignee', '-R'],
      ];
      for (const [key, value] of cases) {
        const r = await s.forge('config', 'set', key, value);
        assert.equal(r.code, 1, `${key} ${value} exits 1`);
        assert.ok(r.err.includes(key), `${key} ${value}: the message names the key (${r.err})`);
        assert.equal(s.read(), FIXTURE, `${key} ${value} leaves the file byte-identical`);
      }
      for (const [key, value, expected] of [
        ['daemon.idleStopMinutes', 'null', null],
        ['pipeline.budget.tokens', 'null', null],
        ['pipeline.budget.usd', '2.5', 2.5],
        ['runtime.diversity', 'true', true],
        ['review.blockOn', '[blocker,major,minor]', ['blocker', 'major', 'minor']],
        ['review.blockOn', '[blocker, major]', ['blocker', 'major']],
        ['tracker.github.labels.prefix', 'ci/', 'ci/'],
      ] as const) {
        const r = await s.forge('config', 'set', key, value);
        assert.equal(r.code, 0, `${key} ${value}: ${r.err}`);
        assert.deepEqual(JSON.parse(r.out).value, expected, key);
      }
    } finally {
      s.repo.cleanup();
    }
  });

  test('runtime.effort accepts the five levels and null', async () => {
    const f = FIELDS.find((x) => x.key === 'runtime.effort');
    assert.ok(f, 'runtime.effort is in the schema');
    assert.equal(f.section, 'agents');
    assert.equal(f.type, 'enum');
    assert.deepEqual(f.options, [...EFFORTS]);
    assert.equal(f.nullable, true);
    assert.equal(f.editable, true);
    assert.equal(f.default, null);
    const s = scratch();
    try {
      const set = await s.forge('config', 'set', 'runtime.effort', 'xhigh');
      assert.equal(set.code, 0, set.err);
      assert.equal(set.out, '{"ok":true,"key":"runtime.effort","value":"xhigh","previous":null,"changed":true}');
      const lines = s.read().split('\n');
      const at = lines.indexOf('  effort: xhigh');
      assert.ok(at > lines.indexOf('runtime:') && at < lines.indexOf('tracker:'), 'written under runtime:');
      assert.equal(lines.length, FIXTURE.split('\n').length + 1, 'one line added');
      assert.ok(s.read().includes('  diversity: false          # warn on shared model families\n'), 'comments kept');
      for (const level of EFFORTS) assert.equal(setConfigValue(s.repo.dir, 'runtime.effort', level).value, level);
      const cleared = await s.forge('config', 'set', 'runtime.effort', 'null');
      assert.equal(cleared.code, 0, cleared.err);
      assert.equal(JSON.parse(cleared.out).value, null);
      assert.ok(s.read().includes('  effort: null\n'));
      const before = s.read();
      const r = await s.forge('config', 'set', 'runtime.effort', 'ultra');
      assert.equal(r.code, 1);
      assert.ok(r.err.includes('runtime.effort must be one of low | medium | high | xhigh | max, or null (got "ultra")'), r.err);
      assert.equal(s.read(), before, 'ultra leaves the file byte-identical');
      for (const bad of ['--add-dir=/', 'High', 'high --add-dir /', 3, true, ['high']]) {
        assert.throws(() => setConfigValue(s.repo.dir, 'runtime.effort', bad as any), (e: any) => e.reason === 'invalid' && e.message.startsWith('runtime.effort must be one of'), String(bad));
        assert.equal(s.read(), before, `${bad} leaves the file byte-identical`);
      }
    } finally {
      s.repo.cleanup();
    }
  });

  test('per-role and complexity efforts are editable', async () => {
    const keys = [...EFFORT_ROLES.map((r) => `runtime.efforts.${r}`), ...COMPLEXITIES.map((k) => `runtime.effortByComplexity.${k}`)];
    assert.equal(keys.length, 13);
    for (const key of keys) {
      const f = FIELDS.find((x) => x.key === key);
      assert.ok(f, `${key} is in the schema`);
      assert.deepEqual([f.section, f.type, f.options, f.nullable, f.editable, f.default], ['agents', 'enum', [...EFFORTS], true, true, null], key);
    }
    assert.equal(FIELDS.find((x) => x.key === 'runtime.efforts.reviewer')?.label, 'Reviewer effort');
    assert.equal(FIELDS.find((x) => x.key === 'runtime.effortByComplexity.high')?.label, 'Effort for high complexity');
    const s = scratch();
    try {
      const role = await s.forge('config', 'set', 'runtime.efforts.reviewer', 'medium');
      assert.equal(role.code, 0, role.err);
      assert.equal(JSON.parse(role.out).value, 'medium');
      const byComplexity = await s.forge('config', 'set', 'runtime.effortByComplexity.high', 'xhigh');
      assert.equal(byComplexity.code, 0, byComplexity.err);
      const got = await s.forge('config', 'get', 'runtime.effortByComplexity.high');
      assert.equal(got.out, 'xhigh');
      assert.equal((await s.forge('config', 'get', 'runtime.efforts.reviewer')).out, 'medium');
      const before = s.read();
      const r = await s.forge('config', 'set', 'runtime.efforts.reviewer', 'ultra');
      assert.equal(r.code, 1);
      assert.ok(r.err.includes('runtime.efforts.reviewer must be one of low | medium | high | xhigh | max, or null (got "ultra")'), r.err);
      assert.equal(s.read(), before, 'ultra leaves the file byte-identical');
      assert.equal((await s.forge('config', 'set', 'runtime.efforts.orchestrator', 'high')).code, 1, 'no orchestrator key');
    } finally {
      s.repo.cleanup();
    }
  });

  test('set rejects non-editable and unknown keys', async () => {
    const s = scratch();
    try {
      const locked: [string, string][] = [
        ['daemon.command', 'claude -p {session}'],
        ['daemon.allowedTools', '[Agent, Bash]'],
        ['daemon.enabled', 'true'],
        ['commands.test', 'rm -rf /'],
        ['worktrees.setup', '["curl x | sh"]'],
        ['tracker.kind', 'github'],
        ['aiAttribution', 'allow'],
        ['approver.alwaysEscalate', '[]'],
        ['merge.auto', 'true'],
        ['infra.allowed', '[terraform]'],
        ['verify', '[]'],
        ['review.panel', '[]'],
      ];
      for (const [key, value] of locked) {
        const r = await s.forge('config', 'set', key, value);
        assert.equal(r.code, 1, key);
        assert.match(r.err, /is not editable with forge config set/, key);
        assert.equal(s.read(), FIXTURE, `${key}: file unchanged`);
      }
      const r = await s.forge('config', 'set', 'nope.key', '1');
      assert.equal(r.code, 1);
      assert.match(r.err, /unknown config key "nope\.key"/);
      assert.equal(s.read(), FIXTURE);
    } finally {
      s.repo.cleanup();
    }
  });

  test('worktrees.generated and generatedBy are locked', async () => {
    const s = scratch();
    try {
      for (const [key, value] of [['worktrees.generated', ['dist/**']], ['worktrees.generatedBy', 'test']] as const) {
        assert.throws(() => setConfigValue(s.repo.dir, key, value as any), (e: any) => e.reason === 'locked', key);
        assert.equal(s.read(), FIXTURE, `${key}: file unchanged`);
      }
    } finally {
      s.repo.cleanup();
    }
  });

  test('verifySecrets is shown and locked', async () => {
    const f = FIELDS.find((x) => x.key === 'verifySecrets');
    assert.ok(f, 'verifySecrets is in the schema');
    assert.deepEqual(
      { key: f.key, section: f.section, type: f.type, options: f.options, editable: f.editable, lockedReason: f.lockedReason, default: f.default },
      { key: 'verifySecrets', section: 'pipeline', type: 'enum', options: ['block', 'warn'], editable: false, lockedReason: 'loosens a security gate', default: 'block' },
    );
    assert.ok(fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8').includes('verifySecrets: block'), 'docs/CONFIG.md names verifySecrets');
    const s = scratch();
    try {
      const r = await s.forge('config', 'set', 'verifySecrets', 'warn');
      assert.equal(r.code, 1);
      assert.match(r.err, /verifySecrets is not editable with forge config set \(loosens a security gate\)/);
      assert.equal(s.read(), FIXTURE, 'the file is untouched');
    } finally {
      s.repo.cleanup();
    }
  });

  test('field schema is an allowlist over documented keys', async () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
    const base = defaults();
    const forbidden = [
      'commands.', 'worktrees.', 'verify', 'git.', 'merge.', 'approver.', 'aiAttribution', 'infra.', 'resources', 'services', 'usage.', 'evals.',
      'review.panel', 'tracker.kind', 'tracker.local.', 'tracker.github.repo', 'tracker.github.comments', 'tracker.github.project.',
      'daemon.command', 'daemon.allowedTools', 'daemon.enabled', 'daemon.maxConcurrent',
    ];
    assert.equal(new Set(FIELDS.map((f) => f.key)).size, FIELDS.length, 'keys are unique');
    for (const f of FIELDS) {
      assert.notEqual(getPath(base, f.key), undefined, `${f.key} resolves in defaults()`);
      assert.deepEqual(f.default, getPath(base, f.key), `${f.key} default`);
      assert.ok(f.label.trim() && f.help.trim(), `${f.key} has a label and help`);
      const seg = f.key.split('.').pop();
      assert.ok(docs.includes(`${seg}:`), `${seg}: is documented in docs/CONFIG.md`);
      assert.equal(f.editable, f.lockedReason === null, `${f.key}: locked fields say why`);
      if (!f.editable) continue;
      assert.match(f.key, /^(pipeline|review|runtime|tracker|dashboard|daemon)\./, `${f.key} is in an editable section`);
      for (const p of forbidden) assert.ok(!f.key.startsWith(p), `${f.key} must not be editable (${p})`);
    }
    assert.ok(FIELDS.some((f) => f.key === 'runtime.models.builder' && f.editable));
    for (const [key, reason] of [['worktrees.generated', 'names paths a command regenerates'], ['worktrees.generatedBy', 'names a command Forge runs']]) {
      const f = FIELDS.find((x) => x.key === key);
      assert.ok(f, `${key} is in the schema`);
      assert.equal(f.section, 'pipeline', key);
      assert.equal(f.lockedReason, reason, key);
    }
    assert.ok(docs.includes('generated:') && docs.includes('generatedBy:'), 'docs/CONFIG.md documents worktrees.generated and generatedBy');
    assert.equal(FIELDS.filter((f) => f.key.startsWith('runtime.models.')).length, Object.keys(base.runtime.models).length, 'one field per role');
  });

  test('set inserts missing keys, skips no-ops and rewrites lists', async () => {
    const s = scratch();
    try {
      assert.equal((await s.forge('config', 'set', 'pipeline.split', 'never')).code, 0);
      const lines = s.read().split('\n');
      const at = lines.indexOf('  split: never');
      assert.ok(at > 0, 'inserted at the children indent');
      assert.equal(lines[at - 1], '    verifyRetries: 2', 'as the last child of pipeline:');
      assert.equal(lines[at + 1], '', 'before the blank line that ends the section');
      assert.equal(lines.length, FIXTURE.split('\n').length + 1);

      const before = s.read();
      // A fixed old mtime, so a rewrite can't hide inside the filesystem's timestamp granularity.
      fs.utimesSync(s.file, 1000, 1000);
      const mtime = fs.statSync(s.file).mtimeMs;
      const r = await s.forge('config', 'set', 'pipeline.maxRounds', '3');
      assert.equal(r.out, '{"ok":true,"key":"pipeline.maxRounds","value":3,"previous":3,"changed":false}');
      assert.equal(s.read(), before);
      assert.equal(fs.statSync(s.file).mtimeMs, mtime, 'a no-op never writes');

      assert.equal((await s.forge('config', 'set', 'review.blockOn', '[blocker, major, nit]')).code, 0);
      assert.ok(s.read().includes('  # Severities that force another round.\n  blockOn:\n    - blocker\n    - major\n    - nit\n  panel:\n'), 'items rewritten in place at the same indent');

      // review.blockOn must keep blocker and major (feedback.md overrides AC5's `[]` example), so the
      // empty-list rewrite is shown on the same block list in memory, and on a block list the CLI may empty.
      assert.ok(setIn(s.read(), ['review', 'blockOn'], []).includes('  blockOn: []\n  panel:\n'));
      assert.equal((await s.forge('config', 'set', 'review.blockOn', '[]')).code, 1, 'blockOn without blocker and major is refused');
      fs.writeFileSync(s.file, s.read().replace('      labels: []            # all must match', '      labels:\n        - ready\n        - triaged'));
      assert.equal((await s.forge('config', 'set', 'tracker.github.ready.labels', '[]')).code, 0);
      assert.ok(s.read().includes('    ready:\n      labels: []\n      milestone: null\n'));
      assert.equal((await s.forge('config', 'set', 'tracker.github.ready.labels', 'urgent')).code, 1, 'a list needs list syntax');
      assert.equal((await s.forge('config', 'set', 'tracker.github.ready.labels', '["a, b", c]')).code, 0);
      assert.ok(s.read().includes('      labels: ["a, b", c]\n'));
      assert.equal((await s.forge('config', 'get', 'tracker.github.ready.labels')).out, '["a, b","c"]');
    } finally {
      s.repo.cleanup();
    }
  });

  test('a layout setIn cannot edit safely is refused untouched', async () => {
    const flow = FIXTURE.replace(/pipeline:\n(  .*\n)+/, 'pipeline: { plan: auto, maxRounds: 3 }\n');
    assert.notEqual(flow, FIXTURE);
    const s = scratch(flow);
    try {
      const r = await s.forge('config', 'set', 'pipeline.maxRounds', '4');
      assert.equal(r.code, 1);
      assert.match(r.err, /flow map; edit it by hand/);
      assert.equal(s.read(), flow, 'byte-identical');
    } finally {
      s.repo.cleanup();
    }
  });

  test('pre-existing problems do not block a valid set', async () => {
    const broken = FIXTURE.replace('    - name: tests\n      always: true\n', '    - name: tests\n      always: true\n    - name: nonexistent-lens\n');
    const s = scratch(broken);
    try {
      assert.match((await s.forge('config', 'validate')).out, /nonexistent-lens/, 'the fixture is broken as intended');
      const r = await s.forge('config', 'set', 'pipeline.maxRounds', '4');
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).changed, true);
      assert.equal(s.read(), broken.replace('maxRounds: 3', 'maxRounds: 4'));
    } finally {
      s.repo.cleanup();
    }
  });

  test('get reads back; set needs an initialized repo', async () => {
    const s = scratch();
    try {
      assert.equal((await s.forge('config', 'set', 'pipeline.maxRounds', '7')).code, 0);
      assert.equal((await s.forge('config', 'get', 'pipeline.maxRounds')).out, '7');
      assert.equal((await s.forge('config', 'get', 'nope.key')).out, 'null');
      assert.equal((await s.forge('config', 'get', 'tracker.github.labels.prefix')).out, 'forge:', 'strings print raw');
    } finally {
      s.repo.cleanup();
    }
    const bare = scratch(null);
    try {
      const r = await bare.forge('config', 'set', 'pipeline.maxRounds', '4');
      assert.equal(r.code, 2);
      assert.match(r.err, /\/forge init/);
      assert.equal(fs.existsSync(path.join(bare.repo.dir, '.forge')), false, 'creates no file');
    } finally {
      bare.repo.cleanup();
    }
  });

  test('a daemon session cannot set config', async () => {
    const s = scratch();
    try {
      const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.repo.dir) };
      assert.equal((await s.cli(daemon, 'config', 'get', 'pipeline.maxRounds')).code, 0, 'the trust snapshot matches');
      const r = await s.cli(daemon, 'config', 'set', 'pipeline.maxRounds', '4');
      assert.notEqual(r.code, 0);
      assert.match(r.err, /a daemon session may not do/);
      assert.equal(s.read(), FIXTURE);
    } finally {
      s.repo.cleanup();
    }
  });
});
