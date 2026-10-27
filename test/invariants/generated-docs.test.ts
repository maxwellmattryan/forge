// The generated docs are what `npm run docs` writes, every config key has a doc string beside its
// default, and the dashboard's settings allowlist covers only documented keys (folded from
// config-set.test.ts). Docs stay in sync with code: docs/TESTING.md › Allowed source-text tests, entry 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '#core/config/load.ts';
import { FIELDS } from '#core/config/fields.ts';
import { getPath } from '#core/shape.ts';
import { KEY_DOCS } from '#core/config/keys/docs.ts';
import { configDocProblems, renderConfigReference, syncConfigDoc } from '#core/config/keys/reference.ts';
import { parse } from '#core/format/yaml.ts';
import { syncCliDoc, syncCommonCommands } from '../../lib/cli/commands/help.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('generated docs are what npm run docs writes', () => {
  for (const [file, sync] of [
    ['docs/CONFIG.md', syncConfigDoc],
    ['docs/CLI.md', syncCliDoc],
    ['docs/CLI.md', syncCommonCommands],
  ] as const) {
    const text = read(file);
    assert.ok(sync(text) === text, `${file} is stale: run npm run docs`);
  }
});

test('every config key is documented beside its default', () => {
  const problems = configDocProblems(defaults(), KEY_DOCS);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(parse(renderConfigReference()), defaults());
});

test('field schema is an allowlist over documented keys', async () => {
  const base = defaults();
  const documented = (key: string) => Boolean(KEY_DOCS[key]?.doc.trim()) || KEY_DOCS[key.split('.').slice(0, -1).join('.')]?.uniform === true;
  const forbidden = [
    'commands.', 'worktrees.', 'verify', 'git.', 'merge.', 'approver.', 'aiAttribution', 'infra.', 'resources', 'components', 'repos', 'checkout', 'usage.', 'evals.',
    'review.panel', 'tracker.kind', 'tracker.local.', 'tracker.github.repo', 'tracker.github.comments', 'tracker.github.project.',
    'daemon.command', 'daemon.allowedTools', 'daemon.enabled', 'daemon.maxConcurrent', 'notify.', 'commandEnv.',
  ];
  assert.equal(new Set(FIELDS.map((f) => f.key)).size, FIELDS.length, 'keys are unique');
  for (const f of FIELDS) {
    assert.notEqual(getPath(base, f.key), undefined, `${f.key} resolves in defaults()`);
    assert.deepEqual(f.default, getPath(base, f.key), `${f.key} default`);
    assert.ok(f.label.trim() && f.help.trim(), `${f.key} has a label and help`);
    assert.ok(documented(f.key), `${f.key} has a KEY_DOCS entry in lib/core/config/keys/docs.ts or sits under a uniform parent`);
    assert.equal(f.editable, f.lockedReason === null, `${f.key}: locked fields say why`);
    if (!f.editable) continue;
    // pr.integrationReview only chooses between reviewing and skipping a docs-only conflict review; the rest of pr.* stays locked.
    // retention.logMaxBytes only moves when a log rotates (1 MiB floor); jobsDays and logsDays delete files and stay locked.
    // budget.* only caps spend: raising it never runs, loads or writes anything.
    // outcomes.windowDays only sets how long sync watches a merged job; it names nothing Forge runs.
    // scoring.sample and scoring.model pick which merged jobs get a judge run and its model; budgets still hold it.
    // environments.maxRunning only caps running environments: a wrong value stops (never removes) one.
    // pr.maxCiReworks only caps how many CI reworks sync starts before a person decides.
    // foreman model and effort keys pick a model and how much it thinks, never what it may do.
    assert.match(f.key, /^((pipeline|review|runtime|tracker|dashboard|daemon|budget)\.|pr\.(integrationReview|maxCiReworks)$|retention\.logMaxBytes$|outcomes\.windowDays$|environments\.maxRunning$|scoring\.(sample|model)$|foreman\.((assistants|surveyors|senior)\.)?(model|effort)$)/, `${f.key} is in an editable section`);
    for (const p of forbidden) assert.ok(!f.key.startsWith(p), `${f.key} must not be editable (${p})`);
  }
  assert.ok(FIELDS.some((f) => f.key === 'runtime.models.builder' && f.editable));
  for (const [key, reason] of [
    ['worktrees.generated', 'names paths a command regenerates'],
    ['worktrees.generatedBy', 'names a command Forge runs'],
    ['commandEnv.inherit', 'widens what configured commands can read'],
    ['commandEnv.loginShell', 'sources the login profile in every configured command'],
  ]) {
    const f = FIELDS.find((x) => x.key === key);
    assert.ok(f, `${key} is in the schema`);
    assert.equal(f.section, 'pipeline', key);
    assert.equal(f.lockedReason, reason, key);
    assert.ok(KEY_DOCS[key]?.doc.trim(), `${key} has a doc string`);
  }
  assert.equal(FIELDS.find((f) => f.key === 'commandEnv.inherit')?.type, 'list');
  assert.equal(FIELDS.find((f) => f.key === 'commandEnv.loginShell')?.type, 'boolean');
  assert.ok(KEY_DOCS['worktrees.generated']?.doc.trim() && KEY_DOCS['worktrees.generatedBy']?.doc.trim(), 'worktrees.generated and worktrees.generatedBy have doc strings');
  assert.equal(FIELDS.filter((f) => f.key.startsWith('runtime.models.')).length, Object.keys(base.runtime.models).length, 'one field per role');
});
