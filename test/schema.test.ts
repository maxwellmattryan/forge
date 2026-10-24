// Every schema migration, one table per versioned shape. Rows are keyed by step id (the lists in
// lib/core/versions/): a row runs the real reader from the version its step upgrades (the step's
// position + 1, which the runner sets) to the current one, and checks only the fields that step (and
// the later ones it chains through) is about. This is the only test file that may state a version
// number: a new step adds one row here and edits nothing else (`every migration has a table row`
// names a missing one).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '#core/config/load.ts';
import { disclosureOf } from '#core/config/fields.ts';
import { CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION, migrateConfig, normalizeEvent, normalizeJob, serializeJob } from '#core/job/schema.ts';
import { CONFIG_STEPS } from '#core/versions/config.ts';
import { JOB_STEPS } from '#core/versions/job.ts';
import { EVENT_STEPS } from '#core/versions/event.ts';
import { stepProblems } from '#core/versions/steps.ts';
import type { Step } from '#core/versions/steps.ts';
import { API_CHANGES } from '#api/versions.ts';
import { createJob, jobDir, leaseStatus, loadJob, updateJob } from '#core/job/store.ts';
import { issueLinkStatus } from '#core/job/issue-link.ts';
import * as yaml from '#core/format/yaml.ts';

type Row = { step: string; input: Record<string, unknown>; fields: Record<string, unknown>; removed?: string[]; note?: string };

const MISSING = Symbol('missing');
/** The value at a dotted path, or MISSING when any segment is absent. */
function get(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return MISSING;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const DOWNSTREAM = { enabled: true, max: 5, skip: [] };
const SERVICE = { name: 'api', path: 'svc/api', commands: { test: 't' }, owners: ['@a'], notes: 'n' };
const REPOS = [{ name: 'lib', remote: 'https://example.com/lib.git', defaultBranch: 'main' }];
const LINKED = [{ name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: { ecosystem: 'npm', name: '@acme/lib' } }] }];
const SINKS = [{ name: 'api', path: 'services/api', kind: 'service', config: [{ env: { PORT_HTTP: '{port}' } }, { 'env-file': '.env.local', values: { JOB_ID: '{job}' } }] }];
const PR = { number: 7, url: 'https://github.com/acme/web/pull/7', state: 'OPEN' };
const OWNER = { session: 'S-old', host: 'laptop.local', since: '2026-10-01T10:00:00.000Z', heartbeat: '2026-10-01T11:00:00.000Z' };
const AGENTS = { builder: { runs: 2, status: 'done', agentId: 'a1', startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:02:00.000Z', round: 1, importedThrough: { a1: '2026-10-01T10:02:00.000Z' } } };
const run = (round: number, attempt: number, ok: boolean, sha: string | null = null) => ({ round, attempt, sha, ok, at: null, file: `verify/round-${round}.md` });
const FOREMAN = { login: null, source: 'foreman' };
const UNKNOWN = { login: null, source: 'unknown' };
const ONLY_VERSION = 'only bumps the version: the new keys come from defaults()';

const CONFIG_ROWS: Row[] = [
  {
    step: 'dashboard-launcher-to-daemon',
    input: { dashboard: { port: 7411, launcher: 'claude -p "{prompt}"' } },
    fields: { 'daemon.command': 'claude -p "{prompt}"', 'dashboard.port': 7411 },
    removed: ['dashboard.launcher', 'daemon.enabled'],
    note: 'a launcher becomes daemon.command, never enabled',
  },
  { step: 'parallel-verify-steps', input: { verify: ['build', 'lint'] }, fields: { verify: ['build', 'lint'] }, note: 'every v2 verify list is a valid v3 list' },
  { step: 'runtime-efforts', input: { git: { base: 'trunk' } }, fields: { 'git.base': 'trunk' }, removed: ['runtime'], note: ONLY_VERSION },
  {
    step: 'foreman-block',
    input: { git: { base: 'trunk' }, runtime: { models: { builder: 'sonnet' } } },
    fields: { 'runtime.models': { builder: 'sonnet' }, repos: [], downstream: DOWNSTREAM },
    removed: ['foreman', 'runtime.models.assistant'],
    note: ONLY_VERSION,
  },
  { step: 'policy-protected-paths', input: { git: { base: 'trunk' }, approver: { alwaysEscalate: ['x'] } }, fields: { 'approver.alwaysEscalate': ['x'], repos: [], downstream: DOWNSTREAM }, removed: ['policy'], note: ONLY_VERSION },
  { step: 'retention', input: { git: { base: 'trunk' }, daemon: { maxConcurrent: 2 } }, fields: { 'daemon.maxConcurrent': 2, repos: [], downstream: DOWNSTREAM }, removed: ['retention'], note: ONLY_VERSION },
  { step: 'notify', input: { git: { base: 'trunk' }, retention: { jobsDays: 30 } }, fields: { 'retention.jobsDays': 30, repos: [], downstream: DOWNSTREAM }, removed: ['notify'], note: ONLY_VERSION },
  { step: 'repo-budget', input: { git: { base: 'trunk' }, notify: { webhooks: [], command: null } }, fields: { notify: { webhooks: [], command: null }, repos: [], downstream: DOWNSTREAM }, removed: ['budget'], note: ONLY_VERSION },
  {
    step: 'services-to-components',
    input: { services: [SERVICE] },
    fields: { components: [{ ...SERVICE, kind: 'service', dependsOn: [] }], repos: [], downstream: DOWNSTREAM },
    removed: ['services'],
    note: 'each service becomes a service component with no dependencies',
  },
  { step: 'member-repos', input: { tracker: { kind: 'none' }, components: [] }, fields: { components: [], repos: [], downstream: DOWNSTREAM }, note: 'member repos start empty' },
  { step: 'depends-on-links', input: { repos: REPOS, components: LINKED }, fields: { repos: REPOS, components: LINKED, downstream: DOWNSTREAM }, note: 'dependsOn links are kept as written' },
  { step: 'release-interim', input: { repos: REPOS, components: LINKED, aiAttribution: 'forbid' }, fields: { components: LINKED, aiAttribution: 'forbid', downstream: DOWNSTREAM }, removed: ['release'], note: ONLY_VERSION },
  { step: 'downstream-verification', input: { repos: REPOS, git: { base: 'trunk' } }, fields: { repos: REPOS, 'git.base': 'trunk', downstream: DOWNSTREAM }, note: 'gains the downstream default' },
  { step: 'checkout', input: { git: { base: 'trunk' }, components: [], repos: [], downstream: DOWNSTREAM }, fields: { 'git.base': 'trunk', downstream: DOWNSTREAM }, removed: ['checkout'], note: ONLY_VERSION },
  { step: 'release-strategy', input: { release: { interim: 'canary' }, checkout: [] }, fields: { release: { interim: 'canary' }, checkout: [] }, removed: ['release.mechanism'], note: ONLY_VERSION },
  {
    step: 'release-publish',
    input: { release: { interim: 'canary', mechanism: 'tag', command: 'git tag v1' }, repos: [{ ...REPOS[0], release: { mechanism: 'changesets' } }] },
    fields: { release: { interim: 'canary', mechanism: 'tag', command: 'git tag v1' }, 'repos.0.release': { mechanism: 'changesets' } },
    removed: ['release.publish'],
    note: ONLY_VERSION,
  },
  { step: 'reserved-gate-release', input: { foreman: { enabled: true, reserved: ['secret'] } }, fields: { foreman: { enabled: true, reserved: ['secret', 'gate:release'] } }, note: 'a written-out reserved list gains gate:release' },
  { step: 'backing', input: { git: { base: 'trunk' }, foreman: { reserved: ['secret'] } }, fields: { 'foreman.reserved': ['secret'], 'git.base': 'trunk' }, removed: ['backing'], note: 'a v18 reserved list is left as written' },
  { step: 'config-sinks', input: { components: SINKS }, fields: { components: SINKS }, note: ONLY_VERSION },
  {
    step: 'builder-models-and-rework-panel',
    input: { tracker: { kind: 'none' }, runtime: { models: { builder: 'opus' } }, review: { onPrFeedback: 'full' } },
    fields: { 'runtime.models': { builder: 'opus' }, review: { onPrFeedback: 'full' } },
    removed: ['runtime.modelByComplexity', 'runtime.reworkModel', 'review.onRework'],
    note: ONLY_VERSION,
  },
  {
    step: 'backing-database',
    input: { git: { base: 'trunk' }, backing: [{ name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] }] },
    fields: { backing: [{ name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] }] },
    removed: ['backing.0.database'],
    note: ONLY_VERSION,
  },
  { step: 'secrets', input: { tracker: { kind: 'none' }, backing: [] }, fields: { backing: [], 'tracker.kind': 'none' }, removed: ['secrets'], note: ONLY_VERSION },
  { step: 'outcomes-window', input: { tracker: { kind: 'none' }, secrets: {}, outcomes: { windowDays: 7 } }, fields: { secrets: {}, outcomes: { windowDays: 7 } }, note: 'a written outcome window is kept' },
  { step: 'environments-max-running', input: { tracker: { kind: 'none' }, outcomes: { windowDays: 14 } }, fields: { outcomes: { windowDays: 14 } }, removed: ['environments'], note: ONLY_VERSION },
  { step: 'scoring', input: { tracker: { kind: 'none' } }, fields: { 'tracker.kind': 'none' }, removed: ['scoring'], note: ONLY_VERSION },
  {
    step: 'loop-bounds',
    input: { pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } },
    fields: { pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } },
    removed: ['pipeline.maxTotalRounds', 'pr.maxCiReworks', 'daemon.jobBudget'],
    note: ONLY_VERSION,
  },
  { step: 'daemon-turn-timeout', input: { daemon: { enabled: true } }, fields: { daemon: { enabled: true } }, removed: ['daemon.turnTimeoutMinutes'], note: ONLY_VERSION },
  { step: 'experiments-and-recall', input: { improve: { retroEvery: 5 }, evals: { testPattern: 'x' } }, fields: { improve: { retroEvery: 5 }, evals: { testPattern: 'x' } }, removed: ['improve.experiments', 'evals.recall'], note: ONLY_VERSION },
  { step: 'worktree-seed', input: { worktrees: { setup: ['npm ci'] } }, fields: { worktrees: { setup: ['npm ci'] } }, removed: ['worktrees.seed'], note: ONLY_VERSION },
  {
    step: 'instructions-per-role',
    input: { project: { name: 'x', instructions: ['AGENTS.md', 'docs/DEVELOPING.md'] } },
    fields: { 'project.instructions': { default: ['AGENTS.md', 'docs/DEVELOPING.md'] }, 'project.name': 'x' },
    note: "a list becomes the role map's default",
  },
  { step: 'command-env', input: { commands: { test: 'npm test' } }, fields: { 'commands.test': 'npm test' }, removed: ['commandEnv'], note: ONLY_VERSION },
];

const JOB_ROWS: Row[] = [
  {
    step: 'verify-runs',
    input: { id: 'x', verify: { 1: 'FAIL', 2: 'PASS' } },
    fields: { verifyRuns: [run(1, 1, false), run(2, 1, true)], 'verify.1': 'FAIL', verifyRetries: { 1: 1 }, outcome: null, score: null },
    note: 'per-round results become attempt 1 with no sha; a v1 job walks every later migration',
  },
  {
    step: 'budgets-and-verify-retries',
    input: { id: 'x', verifyRuns: [run(1, 1, false), run(1, 2, false), run(1, 3, true), run(2, 1, false), run(2, 2, true)] },
    fields: { verifyRetries: { 1: 2, 2: 1 }, budget: { limits: {}, ack: {}, lastCheck: null }, 'verifyRuns.length': 5 },
    note: 'failed verifies per round are recovered from the run history',
  },
  { step: 'no-issue', input: { id: 'x' }, fields: { noIssue: null } },
  {
    step: 'agent-import-cursor',
    input: {
      id: 'x',
      agents: { builder: { runs: 1, status: 'done', agentId: 'a1', endedAt: '2026-10-01T10:02:00.000Z' }, 'reviewer:code': { runs: 1, status: 'running', agentId: null, endedAt: null } },
    },
    fields: { 'agents.builder.importedThrough': { a1: '2026-10-01T10:02:00.000Z' } },
    removed: ['agents.reviewer:code.importedThrough'],
    note: 'an ended agent gains an import cursor at its end',
  },
  {
    step: 'split-mode',
    input: { id: 'x', agents: AGENTS, verifyRuns: [run(1, 1, false, 'abc')] },
    fields: { splitMode: null, effort: null, agents: AGENTS, verifyRuns: [run(1, 1, false, 'abc')] },
  },
  { step: 'job-effort', input: { id: 'x' }, fields: { effort: null } },
  {
    step: 'human-gate',
    input: { id: 'x', effort: 'high', state: 'waiting', waitingOn: 'escalation', reason: 'r' },
    fields: { effort: 'high', state: 'waiting', waitingOn: 'escalation', reason: 'r' },
    removed: ['_unsupported'],
    note: 'v8 only adds the human gate',
  },
  { step: 'complexity', input: { id: 'x' }, fields: { complexity: null } },
  { step: 'protected-paths', input: { id: 'x' }, fields: { protectedPaths: null } },
  {
    step: 'issues-list',
    input: { id: 'x', source: { tracker: 'github', ref: '12', url: 'https://github.com/acme/web/issues/12' } },
    fields: { issues: [{ tracker: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/issues/12' }] },
    removed: ['source'],
  },
  {
    step: 'member-repos',
    input: { id: 'x', branch: 'forge/x', base: 'main', worktree: '/tmp/x.worktrees/j', pr: PR },
    fields: { repos: [{ repo: null, worktree: '/tmp/x.worktrees/j', branch: 'forge/x', base: 'main', pr: PR, verifyOnly: false, interim: null }], interim: null, ports: {}, outcome: null, score: null },
    note: 'a v11 job becomes a one-repo job',
  },
  {
    step: 'interim-override',
    input: { id: 'x', branch: 'forge/x', base: 'main', repos: [{}, { repo: 'lib', worktree: null, base: 'main', pr: null, verifyOnly: false }] },
    fields: { interim: null, 'repos.0.interim': null, 'repos.1.interim': null, 'repos.1.repo': 'lib' },
  },
  { step: 'component-ports', input: { id: 'x', port: 4103 }, fields: { ports: {}, port: 4103 }, note: 'read as not allocated until the next worktree create' },
  { step: 'outcome', input: { id: 'x', state: 'done', pr: { number: 1, state: 'MERGED' } }, fields: { outcome: null, state: 'done' } },
  { step: 'score', input: { id: 'x', state: 'done', pr: { number: 1, state: 'MERGED' }, outcome: null }, fields: { score: null, outcome: null } },
  {
    step: 'lease',
    input: { id: 'x', title: 'Old', state: 'running', owner: OWNER },
    fields: { lease: { driver: 'S-old', epoch: 1, since: OWNER.since, renewedAt: OWNER.heartbeat, expiresAt: '2026-10-01T11:30:00.000Z' }, state: 'running' },
    removed: ['owner'],
    note: 'the owner keeps driving as epoch 1 for the 30 minutes its heartbeat gave it',
  },
];

const EVENT_ROWS: Row[] = [
  {
    step: 'actor-object',
    input: { ts: 't', type: 'human', action: 'approve', actor: 'foreman' },
    fields: { actor: FOREMAN, action: 'approve', type: 'human', ts: 't' },
    note: 'a legacy actor string becomes the { login, source } object',
  },
  {
    step: 'agent-start-provenance',
    input: { ts: 't', type: 'agent-start', role: 'builder', model: 'opus', output: 'build.md', actor: { login: 'al', source: 'env' } },
    fields: { type: 'agent-start', ts: 't', role: 'builder', model: 'opus', output: 'build.md', actor: { login: 'al', source: 'env' } },
    removed: ['pluginHash', 'promptHash', 'configHash'],
    note: 'an agent-start from before provenance keeps every field and gains no hash',
  },
  {
    step: 'decision-head',
    input: { ts: 't', type: 'decision', decision: 'APPROVE', reason: null },
    fields: { type: 'decision', ts: 't', decision: 'APPROVE', reason: null },
    removed: ['autoMerge', 'head', 'heads'],
    note: 'a decision from before the head binding keeps its fields and gains no head, so it is never eligible',
  },
  {
    step: 'actor-source-daemon',
    input: { ts: 't', type: 'human', action: 'approve', actor: { login: 'al', source: 'daemon' } },
    fields: { type: 'human', ts: 't', action: 'approve', actor: { login: 'al', source: 'daemon' } },
    note: 'an actor recorded by a daemon session keeps source daemon',
  },
  {
    step: 'merge-provenance',
    input: { ts: 't', type: 'pr-merged', number: 7, method: 'squash', checks: 'passing', bypass: false },
    fields: { type: 'pr-merged', ts: 't', number: 7, method: 'squash', checks: 'passing', bypass: false },
    removed: ['actor', 'scope', 'via'],
    note: 'a pr-merged from before provenance keeps its fields and gains no actor, scope or via',
  },
];

/** One versioned shape: its rows, its step list, its current version, the field that holds it, and its reader. */
type Table = [string, Row[], readonly Step[], number, 'schemaVersion' | 'v', (input: Record<string, unknown>) => { out: any; from: unknown }];

const TABLES: Table[] = [
  [
    'config',
    CONFIG_ROWS,
    CONFIG_STEPS,
    CONFIG_SCHEMA_VERSION,
    'schemaVersion',
    (input) => {
      const m = migrateConfig(input);
      return { out: m.config, from: m.from };
    },
  ],
  ['job', JOB_ROWS, JOB_STEPS, JOB_SCHEMA_VERSION, 'schemaVersion', (input) => ({ out: normalizeJob(input), from: undefined })],
  ['event', EVENT_ROWS, EVENT_STEPS, EVENT_SCHEMA_VERSION, 'v', (input) => ({ out: normalizeEvent(input), from: undefined })],
];

for (const [name, rows, steps, current, key, read] of TABLES) {
  for (const row of rows) {
    // The version a row starts from is its step's position + 1, so no row states a number.
    const from = steps.findIndex((s) => s.id === row.step) + 1;
    test(`${name} ${row.step}: v${from} → v${from + 1}`, () => {
      assert.ok(from > 0, `${row.step} is a step in the ${name} list`);
      const { out, from: migratedFrom } = read({ ...structuredClone(row.input), [key]: from });
      if (name === 'config') assert.equal(migratedFrom, from, 'migratedFrom names the old version');
      assert.equal(out[key], current, 'reaches the current version');
      for (const [p, want] of Object.entries(row.fields)) assert.deepStrictEqual(get(out, p), want, p);
      for (const p of row.removed ?? []) assert.equal(get(out, p), MISSING, `${p} is absent`);
    });
  }
}

test('every migration has a table row', () => {
  const problems: string[] = [];
  for (const [name, rows, steps] of TABLES) {
    const ids = new Set(steps.map((s) => s.id));
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.step)) problems.push(`${name} migration table has two rows for ${row.step}`);
      seen.add(row.step);
      if (!ids.has(row.step)) problems.push(`${name} migration table has a row for ${row.step}, which is not a step in its list`);
      if (!Object.keys(row.fields).length && !row.removed?.length && !row.note?.trim())
        problems.push(`${name} ${row.step} row checks nothing: add a note saying the step only bumps the version`);
    }
    steps.forEach((s, i) => {
      if (!seen.has(s.id)) problems.push(`${name} migration table has no row for ${s.id} (v${i + 1} → v${i + 2})`);
    });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// The ids each list must start with, so inserting, removing, reordering or renaming an existing step
// fails while appending passes. Jobs never edit FROZEN: only a release commit or the 1.0 reset (#280)
// extends it, and only with ids already on develop, so an append never re-pins anything.
const FROZEN: Record<'config' | 'job' | 'event' | 'api', string[]> = {
  config: [
    'dashboard-launcher-to-daemon',
    'parallel-verify-steps',
    'runtime-efforts',
    'foreman-block',
    'policy-protected-paths',
    'retention',
    'notify',
    'repo-budget',
    'services-to-components',
    'member-repos',
    'depends-on-links',
    'release-interim',
    'downstream-verification',
    'checkout',
    'release-strategy',
    'release-publish',
    'reserved-gate-release',
    'backing',
    'config-sinks',
    'builder-models-and-rework-panel',
    'backing-database',
    'secrets',
    'outcomes-window',
    'environments-max-running',
    'scoring',
    'loop-bounds',
    'daemon-turn-timeout',
    'experiments-and-recall',
  ],
  job: [
    'verify-runs',
    'budgets-and-verify-retries',
    'no-issue',
    'agent-import-cursor',
    'split-mode',
    'job-effort',
    'human-gate',
    'complexity',
    'protected-paths',
    'issues-list',
    'member-repos',
    'interim-override',
    'component-ports',
    'outcome',
    'score',
    'lease',
  ],
  event: ['actor-object', 'agent-start-provenance'],
  api: Array.from({ length: 36 }, (_, i) => `api-${i + 2}`),
};

test('version lists only grow at the end', () => {
  const lists: Record<keyof typeof FROZEN, readonly { readonly id: string }[]> = { config: CONFIG_STEPS, job: JOB_STEPS, event: EVENT_STEPS, api: API_CHANGES };
  for (const [k, list] of Object.entries(lists) as [keyof typeof FROZEN, readonly { readonly id: string }[]][]) {
    assert.deepEqual(
      list.slice(0, FROZEN[k].length).map((s) => s.id),
      FROZEN[k],
      `the ${k} list must start with its frozen ids: append a new step at the end, never edit, insert, reorder or remove one`,
    );
    assert.deepEqual(stepProblems(list), [], `${k} list ids`);
  }
});

test('no version literals outside schema.test.ts', () => {
  const LITERAL = /(SCHEMA|API)_VERSION, \d+|schemaVersion: \d+|apiVersion, \d+/;
  const dir = import.meta.dirname;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'schema.test.ts').sort()) {
    fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (LITERAL.test(line) && !line.includes('// old-version fixture')) offenders.push(`test/${file}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], `import the constant from lib/schema.ts, or mark a deliberate old fixture with // old-version fixture:\n${offenders.join('\n')}`);
});

// Inputs a single row cannot hold: the other shapes a migration must handle.

test('config v1 → v2: other launcher shapes', () => {
  assert.equal(migrateConfig({ schemaVersion: 1, dashboard: { port: 7400, launcher: null } }).config.daemon, undefined, 'no launcher, no daemon block');
  const kept = migrateConfig({ schemaVersion: 1, dashboard: { launcher: 'my-claude {session}' }, daemon: { command: 'kept {session}' } }).config;
  assert.equal(kept.daemon.command, 'kept {session}', 'an existing daemon.command wins');
  assert.equal('dashboard' in migrateConfig({ schemaVersion: 1, git: { base: 'main' } }).config, false, 'no dashboard key is invented');
});

test('config v9 and v10: services fold at any version', () => {
  const folded = migrateConfig({ schemaVersion: 10, services: [{ name: 'api', path: 'api' }] }).config;
  assert.deepEqual(folded.components, [{ name: 'api', path: 'api', kind: 'service', dependsOn: [] }]);
  assert.equal('services' in folded, false);
  assert.deepEqual(folded.repos, []);
  assert.equal(migrateConfig({ schemaVersion: 10, repos: 'nope' }).config.repos, 'nope', 'an existing repos value is kept for validation to judge');
  // An unversioned config that still says services folds the same way.
  assert.deepEqual(migrateConfig({ services: [structuredClone(SERVICE)] }).config.components, [{ ...SERVICE, kind: 'service', dependsOn: [] }]);
});

test('config v13 → v14: an existing downstream value is kept', () => {
  assert.deepEqual(migrateConfig({ schemaVersion: 13, downstream: { enabled: false, max: 'x' } }).config.downstream, { enabled: false, max: 'x' }, 'kept for validation to judge');
});

test('config v17 → v18: gate:release is never added twice, nor a foreman block invented', () => {
  assert.deepEqual(migrateConfig({ schemaVersion: 17, foreman: { reserved: ['secret', 'gate:release'] } }).config.foreman.reserved, ['secret', 'gate:release']);
  assert.equal('foreman' in migrateConfig({ schemaVersion: 17, git: { base: 'trunk' } }).config, false);
});

test('config v23 → v24: no outcomes key is added, defaults fill it', () => {
  assert.equal('outcomes' in migrateConfig({ schemaVersion: 23 }).config, false);
});

test('a config or job from a newer Forge is refused, not migrated', () => {
  assert.equal(migrateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 }).from, CONFIG_SCHEMA_VERSION + 1, 'left for validation to refuse');
  assert.deepEqual(validateConfig({ ...defaults(), schemaVersion: CONFIG_SCHEMA_VERSION + 1 }, process.cwd()), [
    `config schemaVersion ${CONFIG_SCHEMA_VERSION + 1} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update the plugin`,
  ]);
  assert.equal(normalizeJob({ id: 'x', schemaVersion: JOB_SCHEMA_VERSION + 1 })._unsupported, true);
});

test('job v6 → v7: a v6 job that somehow has a valid effort keeps it', () => {
  assert.equal(normalizeJob({ id: 'x', schemaVersion: 6, effort: 'low' }).effort, 'low');
});

test('job v10 → v11: each source shape', () => {
  const repo = tempRepo();
  try {
    const base = serializeJob(createJob(repo.dir, defaults(), { title: 'Old v10' })) as any;
    delete base.issues;
    const v10 = (source: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, schemaVersion: 10, source });
    const cases: [unknown, Record<string, unknown>, unknown[]][] = [
      [{ tracker: 'github', ref: '12', url: 'https://github.com/acme/web/issues/12' }, {}, [{ tracker: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/issues/12' }]],
      [{ tracker: 'local', ref: 'reading-time', url: null }, {}, [{ tracker: 'local', ref: 'reading-time', url: null }]],
      [{ tracker: 'local', ref: null, url: 'https://example.test/x' }, {}, [{ tracker: 'local', ref: null, url: 'https://example.test/x' }]],
      [null, { noIssue: { reason: 'tiny', at: '2026-10-01T00:00:00Z' } }, []],
      [{ tracker: 'github', ref: '7', url: null }, {}, [{ tracker: 'github', ref: '7', url: null }]],
      [{ tracker: 'github', ref: '7', url: 'https://github.com/acme/web/issues/8' }, {}, [{ tracker: 'github', ref: '7', url: 'https://github.com/acme/web/issues/8' }]],
      // `forge job new --ref` stored these unchecked before v11; they stay linked in the nearest valid form.
      [{ tracker: 'local', ref: 'ends done', url: null }, {}, [{ tracker: 'local', ref: 'ends-done', url: null }]],
      [{ tracker: 'acme', ref: 'a:b', url: 'https://example.test/a' }, {}, [{ tracker: 'acme', ref: 'a-b', url: 'https://example.test/a' }]],
      [{ tracker: 'local', ref: '  ', url: 'https://example.test/u' }, {}, [{ tracker: 'local', ref: null, url: 'https://example.test/u' }]],
      [{ tracker: 'github', ref: '3', url: 'https://ghe.example/a/b/issues/3' }, {}, [{ tracker: 'github', ref: 'a/b#3', url: 'https://ghe.example/a/b/issues/3' }]],
    ];
    for (const [source, extra, issues] of cases) {
      const raw = v10(source, extra);
      const job = normalizeJob(raw);
      assert.deepEqual(job.issues, issues, JSON.stringify(source));
      assert.deepEqual(job.noIssue, raw.noIssue, 'noIssue unchanged');
      const { issues: _i, schemaVersion: _v, ...rest } = job as any;
      const { source: _s, schemaVersion: _w, ...before } = raw;
      assert.deepEqual(rest, before, 'every other field is the v10 read');
      assert.ok(!('source' in serializeJob(job)));
      if (source && (source as any).ref?.trim?.()) assert.equal(issueLinkStatus(job, { tracker: { kind: (source as any).tracker } } as any), 'linked', 'a linked v10 job stays linked');
    }
  } finally {
    repo.cleanup();
  }
});

test('job v16 → v17: other owner shapes', () => {
  const none = { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null };
  assert.deepEqual(normalizeJob({ schemaVersion: 16, id: 'x', owner: null }).lease, none, 'no owner: no driver, epoch 0');
  // An unparseable heartbeat keeps the driver but reads as expired.
  const garbled = normalizeJob({ schemaVersion: 16, id: 'x', owner: { session: 'S', host: 'h', since: 'x', heartbeat: 'not a time' } });
  assert.deepEqual([garbled.lease.driver, garbled.lease.expiresAt, leaseStatus(garbled).status], ['S', null, 'expired']);
});

test('event v1 → v2: other actor shapes', () => {
  const v1 = { v: 1, ts: 't', type: 'human', action: 'approve' };
  assert.deepEqual(normalizeEvent({ ...v1, actor: 'human' })!.actor, UNKNOWN);
  assert.deepEqual(normalizeEvent(v1)!.actor, UNKNOWN, 'a v1 human event without actor');
  const { v: _, ...unversioned } = v1;
  const read = normalizeEvent({ ...unversioned, actor: 'foreman' })!;
  assert.deepEqual([read.v, read.actor], [EVENT_SCHEMA_VERSION, FOREMAN], 'no v reads as v1');
  // Other v1 events are kept and get no actor.
  assert.deepEqual(normalizeEvent({ v: 1, ts: 't', type: 'claimed', session: 's' }), { v: EVENT_SCHEMA_VERSION, ts: 't', type: 'claimed', session: 's' });
});

// Behaviour on load that a row cannot show: defaults filling the keys a version added.

test('an old config loads with the defaults its later versions added', () => {
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const load = (raw: Record<string, unknown>) => {
      fs.writeFileSync(cfg, yaml.stringify(raw));
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, raw.schemaVersion);
      assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION);
      return loaded.config;
    };
    assert.deepEqual(load({ schemaVersion: 22, tracker: { kind: 'none' }, backing: [] }).secrets, {}, 'secrets defaults to an empty map');
    assert.deepEqual(load({ schemaVersion: 24, tracker: { kind: 'none' }, outcomes: { windowDays: 14 } }).environments, { maxRunning: null }, 'no cap by default');
    const v26 = load({ schemaVersion: 26, tracker: { kind: 'none' }, pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } });
    assert.equal(v26.pipeline.maxTotalRounds, null);
    assert.equal(v26.pr.maxCiReworks, 3);
    assert.deepEqual(v26.daemon.jobBudget, { tokens: 600000000, usd: 150 });
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('secrets'), 'command');
  assert.equal(disclosureOf('secrets.DB_PASSWORD.env'), 'command');
  assert.equal(disclosureOf('environments.maxRunning'), 'plain');
  assert.equal(disclosureOf('commandEnv.loginShell'), 'plain');
  assert.equal(disclosureOf('commandEnv.inherit'), 'text');
});

test('a v16 job is written back as current, with a lease and no owner', () => {
  const repo = tempRepo();
  try {
    const dir = path.join(jobDir(repo.dir, 'old-job'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'job.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 16, id: 'old-job', title: 'Old', state: 'running', owner: OWNER }));
    const loaded = loadJob(repo.dir, 'old-job');
    updateJob(repo.dir, 'old-job', () => {});
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.schemaVersion, JOB_SCHEMA_VERSION);
    assert.equal('owner' in written, false);
    assert.deepEqual(written.lease, loaded.lease);
  } finally {
    repo.cleanup();
  }
});

test('a current-version lease is read field by field', () => {
  // A partial or planted lease never reads as live by accident.
  assert.deepEqual(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x' }).lease, { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });
  assert.deepEqual(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x', lease: { driver: 'S', epoch: -2, expiresAt: 42 } }).lease, { driver: 'S', epoch: 0, since: null, renewedAt: null, expiresAt: null });
});

test('validates maxTotalRounds, maxCiReworks and daemon.jobBudget', () => {
  const problems = (edit: (c: any) => void, key: string) => {
    const c: any = defaults();
    edit(c);
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith(key));
  };
  assert.deepEqual(problems(() => {}, 'pipeline.maxTotalRounds'), []);
  assert.deepEqual(problems((c) => (c.pipeline.maxTotalRounds = 8), 'pipeline.maxTotalRounds'), []);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 0), 'pipeline.maxTotalRounds').length, 1);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 2.5), 'pipeline.maxTotalRounds').length, 1);
  assert.deepEqual(problems((c) => (c.pr.maxCiReworks = 0), 'pr.maxCiReworks'), []);
  assert.equal(problems((c) => (c.pr.maxCiReworks = -1), 'pr.maxCiReworks').length, 1);
  assert.equal(problems((c) => (c.pr.maxCiReworks = 1.5), 'pr.maxCiReworks').length, 1);
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = null), 'daemon.jobBudget'), []);
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = { tokens: null, usd: 20, minutes: 90 }), 'daemon.jobBudget'), []);
  assert.equal(problems((c) => (c.daemon.jobBudget = { usd: -1 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { changedLines: 5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { tokens: 1.5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = [1]), 'daemon.jobBudget').length, 1);
});
