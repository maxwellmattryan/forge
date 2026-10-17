import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { TRUST_ENV, defaults, trustDigest, validateConfig } from '../lib/config.ts';
import { CONFIG_DISCLOSURE, FIELDS, disclosureOf, redactedConfig } from '../lib/config-fields.ts';
import { COMPLEXITIES, EFFORT_ROLES, EFFORTS } from '../lib/schema.ts';
import { setConfigValue } from '../lib/config-set.ts';
import { applyOverlay, overlayProblems } from '../lib/eval-overlay.ts';
import { getPath } from '../lib/util.ts';
import { setIn } from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ACTOR = () => ({ login: 'lib-caller', source: 'env' }) as const;
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
      for (const level of EFFORTS) assert.equal(setConfigValue(s.repo.dir, 'runtime.effort', level, ACTOR).value, level);
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
        assert.throws(() => setConfigValue(s.repo.dir, 'runtime.effort', bad as any, ACTOR), (e: any) => e.reason === 'invalid' && e.message.startsWith('runtime.effort must be one of'), String(bad));
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

  test('pr.integrationReview defaults to code-only, validates and is settable', async () => {
    assert.equal(defaults().pr.integrationReview, 'code-only');
    const s = scratch();
    try {
      for (const v of ['always', 'code-only'] as const) {
        const c = defaults();
        c.pr.integrationReview = v;
        assert.deepEqual(validateConfig(c, s.repo.dir).filter((p) => p.startsWith('pr.integrationReview')), [], v);
      }
      const bad: any = defaults();
      bad.pr.integrationReview = 'sometimes';
      assert.ok(validateConfig(bad, s.repo.dir).some((p) => p.startsWith('pr.integrationReview must be one of always | code-only')), 'sometimes is reported');
      const set = await s.forge('config', 'set', 'pr.integrationReview', 'always');
      assert.equal(set.code, 0, set.err);
      assert.equal(JSON.parse(set.out).value, 'always');
      assert.equal((await s.forge('config', 'get', 'pr.integrationReview')).out, 'always');
      const before = s.read();
      const r = await s.forge('config', 'set', 'pr.integrationReview', 'maybe');
      assert.equal(r.code, 1);
      assert.match(r.err, /pr\.integrationReview/);
      assert.equal(s.read(), before, 'maybe leaves the file byte-identical');
      assert.throws(() => setConfigValue(s.repo.dir, 'pr.integrationReview', 'maybe', ACTOR), (e: any) => e.reason === 'invalid');
    } finally {
      s.repo.cleanup();
    }
  });

  test('config set records the actor', async () => {
    const s = scratch();
    const audit = path.join(s.repo.dir, '.forge', 'runtime', 'audit.jsonl');
    const lines = () => (fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    try {
      const set = await s.cli({ FORGE_ACTOR: 'alice' }, 'config', 'set', 'runtime.effort', 'high');
      assert.equal(set.code, 0, set.err);
      const [first] = lines();
      assert.deepEqual({ ...first, ts: undefined }, { v: 2, ts: undefined, type: 'config-set', key: 'runtime.effort', previous: null, value: 'high', changed: true, actor: { login: 'alice', source: 'env' } });
      const same = await s.cli({ FORGE_ACTOR: 'alice' }, 'config', 'set', 'runtime.effort', 'high');
      assert.equal(same.code, 0, same.err);
      assert.equal(lines().length, 1, 'an unchanged value appends nothing');
      let asked = 0;
      setConfigValue(s.repo.dir, 'runtime.effort', 'high', () => (asked++, ACTOR()));
      assert.equal(asked, 0, 'an unchanged value never resolves the actor');
      // The server passes dashboardActor; its route is covered in server.test.ts.
      setConfigValue(s.repo.dir, 'runtime.effort', 'low', () => ({ login: 'dash', source: 'dashboard' }));
      assert.deepEqual(lines().at(-1).actor, { login: 'dash', source: 'dashboard' });
      assert.equal(lines().at(-1).previous, 'high');
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
        assert.throws(() => setConfigValue(s.repo.dir, key, value as any, ACTOR), (e: any) => e.reason === 'locked', key);
        assert.equal(s.read(), FIXTURE, `${key}: file unchanged`);
      }
    } finally {
      s.repo.cleanup();
    }
  });

  test('policy.protectedPaths is locked', async () => {
    const f = FIELDS.find((x) => x.key === 'policy.protectedPaths');
    assert.ok(f, 'policy.protectedPaths is in the schema');
    assert.deepEqual(
      { section: f.section, type: f.type, editable: f.editable, lockedReason: f.lockedReason, default: f.default },
      { section: 'pipeline', type: 'object', editable: false, lockedReason: 'names what Forge refuses to write', default: defaults().policy.protectedPaths },
    );
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
    assert.ok(docs.includes('protectedPaths:') && docs.includes('## Protected paths'), 'docs/CONFIG.md documents policy.protectedPaths');
    assert.ok(docs.includes('Paths are code, judgement calls are prose'), 'docs/CONFIG.md states the split');
    const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const untrusted = arch.slice(arch.indexOf('Untrusted input'));
    assert.ok(untrusted.includes('policy.protectedPaths'), 'ARCHITECTURE.md "Untrusted input" names the policy');
    const s = scratch();
    try {
      const r = await s.forge('config', 'set', 'policy.protectedPaths', '[]');
      assert.notEqual(r.code, 0);
      assert.match(r.err, /policy\.protectedPaths is not editable with forge config set \(names what Forge refuses to write\)/);
      assert.equal(s.read(), FIXTURE, 'the file is untouched');
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

  test('notify keys are locked', async () => {
    for (const [key, reason] of [['notify.webhooks', 'names a URL Forge posts to'], ['notify.command', 'runs a program']]) {
      const f = FIELDS.find((x) => x.key === key);
      assert.ok(f, `${key} is in the schema`);
      assert.equal(f.section, 'pipeline', key);
      assert.equal(f.editable, false, key);
      assert.equal(f.lockedReason, reason, key);
    }
    assert.equal(disclosureOf('notify'), 'plain');
    assert.equal(disclosureOf('notify.webhooks'), 'url');
    assert.equal(disclosureOf('notify.command'), 'command');
    const c = defaults();
    c.notify = { webhooks: [{ url: 'https://hooks.example.com/services/T0/B0/SECRETPATH' }], command: './page.sh {title}' };
    const red = JSON.stringify(redactedConfig(c));
    assert.ok(!red.includes('SECRETPATH') && !red.includes('hooks.example.com') && !red.includes('page.sh'), 'a support bundle hides both');
    const s = scratch();
    try {
      for (const [key, value] of [['notify.command', 'x'], ['notify.webhooks', '[]']]) {
        const r = await s.forge('config', 'set', key, value);
        assert.equal(r.code, 1, key);
        assert.match(r.err, new RegExp(`${key.replace('.', '\\.')} is not editable`), key);
      }
      assert.equal(s.read(), FIXTURE, 'the file is untouched');
    } finally {
      s.repo.cleanup();
    }
  });

  test('field schema is an allowlist over documented keys', async () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
    const base = defaults();
    const forbidden = [
      'commands.', 'worktrees.', 'verify', 'git.', 'merge.', 'approver.', 'aiAttribution', 'infra.', 'resources', 'components', 'repos', 'usage.', 'evals.',
      'review.panel', 'tracker.kind', 'tracker.local.', 'tracker.github.repo', 'tracker.github.comments', 'tracker.github.project.',
      'daemon.command', 'daemon.allowedTools', 'daemon.enabled', 'daemon.maxConcurrent', 'notify.',
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
      // pr.integrationReview only chooses between reviewing and skipping a docs-only conflict review; the rest of pr.* stays locked.
      // retention.logMaxBytes only moves when a log rotates (1 MiB floor); jobsDays and logsDays delete files and stay locked.
      // budget.* only caps spend: raising it never runs, loads or writes anything.
      assert.match(f.key, /^((pipeline|review|runtime|tracker|dashboard|daemon|budget)\.|pr\.integrationReview$|retention\.logMaxBytes$)/, `${f.key} is in an editable section`);
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

test('runtime.models.verifier defaults to haiku', () => {
  const base = defaults();
  assert.equal(base.runtime.models.verifier, 'haiku');
  const f = FIELDS.find((x) => x.key === 'runtime.models.verifier');
  assert.ok(f?.editable, 'an editable field');
  assert.equal(f.label, 'Verifier model');
  assert.ok(!(EFFORT_ROLES as readonly string[]).includes('verifier'), 'no runtime.efforts.verifier: an older Forge would reject it');
  assert.ok(fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8').includes('    verifier: haiku'));
  const repo = tempRepo();
  try {
    assert.deepEqual(overlayProblems(repo.dir, base, { 'runtime.models.verifier': 'sonnet' }), [], 'an eval overlay may set it');
    assert.equal(applyOverlay(base, { 'runtime.models.verifier': 'sonnet' }).runtime.models.verifier, 'sonnet');
  } finally {
    repo.cleanup();
  }
});

/** Every leaf key of an object: recursion stops at arrays, empty objects and scalars. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? leafKeys(v as Record<string, unknown>, key) : [key];
  });
}

describe('config disclosure', { concurrency: 4 }, () => {
  test('every config key has a disclosure class', () => {
    const missing = leafKeys(defaults() as unknown as Record<string, unknown>).filter((k) => disclosureOf(k) === null);
    assert.deepEqual(missing, []);
    // The longest prefix wins.
    assert.equal(disclosureOf('worktrees.cleanup'), 'plain');
    assert.equal(disclosureOf('worktrees.setup'), 'command');
    assert.equal(disclosureOf('tracker.github.project.statusField'), 'plain');
    assert.equal(disclosureOf('tracker.github.project.owner'), 'text');
    assert.equal(disclosureOf('no-such-key'), null);
    for (const cls of Object.values(CONFIG_DISCLOSURE)) assert.ok(['plain', 'url', 'command', 'path', 'token', 'text'].includes(cls));
  });

  test('commands, paths, URLs and identities are not plain', () => {
    const expected: Record<string, string> = {
      'commands.test': 'command',
      'commands.build': 'command',
      'worktrees.setup': 'command',
      'daemon.command': 'command',
      'daemon.allowedTools': 'command',
      components: 'command',
      'infra.allowed': 'command',
      'project.instructions': 'path',
      'project.notes': 'path',
      'worktrees.root': 'path',
      'worktrees.copy': 'path',
      'worktrees.cargo.targetDir': 'path',
      'worktrees.generated': 'path',
      'verifyE2e.paths': 'path',
      'tracker.local.path': 'path',
      'tracker.github.project.config': 'path',
      'review.panel': 'path',
      'tracker.github.repo': 'url',
      resources: 'url',
      repos: 'url',
      'project.name': 'text',
      'project.description': 'text',
      'tracker.github.ready.assignee': 'text',
      'tracker.github.project.owner': 'text',
      'pr.reviewers': 'text',
      'approver.alwaysEscalate': 'text',
      'infra.notes': 'text',
      'foreman.reserved': 'text',
    };
    for (const [key, cls] of Object.entries(expected)) assert.equal(disclosureOf(key), cls, key);
  });

  test('redactedConfig hides non-plain and unknown values', () => {
    const c = defaults();
    c.commands.test = 'npm test -- --token x';
    c.daemon.command = 'claude -p';
    c.worktrees.setup = ['npm ci', 'make'];
    c.tracker.github.repo = 'someone/private';
    c.pr.reviewers = ['alice', 'bob'];
    c.project.name = '';
    c.worktrees.copy = [];
    c.tracker.github.project.statusMap = {};
    (c as any).mystery = { anything: 'here' };
    const r = redactedConfig(c) as any;
    assert.equal(r.commands, '<redacted>');
    assert.equal(r.daemon.command, '<redacted>');
    assert.deepEqual(r.worktrees.setup, ['<redacted>', '<redacted>']);
    assert.equal(r.tracker.github.repo, '<redacted>');
    assert.deepEqual(r.pr.reviewers, ['<redacted>', '<redacted>']);
    assert.equal(r.mystery, '<redacted>');
    assert.equal(r.project.name, '');
    assert.equal(r.project.description, null);
    assert.deepEqual(r.worktrees.copy, []);
    assert.deepEqual(r.tracker.github.project.statusMap, {});
    assert.equal(r.pipeline.maxRounds, c.pipeline.maxRounds);
    assert.equal(r.git.base, 'main');
    assert.deepEqual(r.daemon.enabled, c.daemon.enabled);
  });
});
