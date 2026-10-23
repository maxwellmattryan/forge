// The dashboard's config field schema is an allowlist over keys docs/CONFIG.md documents, each with
// defaults() as its default. Kept through the test rewrite (docs/test-rewrite/README.md): docs stay in
// sync with code (docs/TESTING.md › Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '#core/config/load.ts';
import { FIELDS } from '#core/config/fields.ts';
import { getPath } from '#core/shape.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('field schema is an allowlist over documented keys', async () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  const base = defaults();
  const forbidden = [
    'commands.', 'worktrees.', 'verify', 'git.', 'merge.', 'approver.', 'aiAttribution', 'infra.', 'resources', 'components', 'repos', 'checkout', 'usage.', 'evals.',
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
    // outcomes.windowDays only sets how long sync watches a merged job; it names nothing Forge runs.
    // scoring.sample and scoring.model pick which merged jobs get a judge run and its model; budgets still hold it.
    // environments.maxRunning only caps running environments: a wrong value stops (never removes) one.
    // pr.maxCiReworks only caps how many CI reworks sync starts before a person decides.
    assert.match(f.key, /^((pipeline|review|runtime|tracker|dashboard|daemon|budget)\.|pr\.(integrationReview|maxCiReworks)$|retention\.logMaxBytes$|outcomes\.windowDays$|environments\.maxRunning$|scoring\.(sample|model)$)/, `${f.key} is in an editable section`);
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
