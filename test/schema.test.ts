// Every schema migration, one table per versioned shape. A row runs the real reader from its `from`
// version to the current one and checks only the fields that migration (and the later ones it
// chains through) is about. This is the only test file that may state a version number: a bump
// adds one row here and edits nothing else (`every migration has a table row` names a missing one).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { disclosureOf } from '../lib/config-fields.ts';
import { CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION, migrateConfig, normalizeEvent, normalizeJob, serializeJob } from '../lib/schema.ts';
import { createJob, jobDir, leaseStatus, loadJob, updateJob } from '../lib/jobs.ts';
import { issueLinkStatus } from '../lib/issue-link.ts';
import * as yaml from '../lib/yaml.ts';

type Row = { from: number; input: Record<string, unknown>; fields: Record<string, unknown>; removed?: string[]; note?: string };

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
    from: 1,
    input: { schemaVersion: 1, dashboard: { port: 7411, launcher: 'claude -p "{prompt}"' } },
    fields: { 'daemon.command': 'claude -p "{prompt}"', 'dashboard.port': 7411 },
    removed: ['dashboard.launcher', 'daemon.enabled'],
    note: 'a launcher becomes daemon.command, never enabled',
  },
  { from: 2, input: { schemaVersion: 2, verify: ['build', 'lint'] }, fields: { verify: ['build', 'lint'] }, note: 'every v2 verify list is a valid v3 list' },
  { from: 3, input: { schemaVersion: 3, git: { base: 'trunk' } }, fields: { 'git.base': 'trunk' }, removed: ['runtime'], note: ONLY_VERSION },
  {
    from: 4,
    input: { schemaVersion: 4, git: { base: 'trunk' }, runtime: { models: { builder: 'sonnet' } } },
    fields: { 'runtime.models': { builder: 'sonnet' }, repos: [], downstream: DOWNSTREAM },
    removed: ['foreman', 'runtime.models.assistant'],
    note: ONLY_VERSION,
  },
  { from: 5, input: { schemaVersion: 5, git: { base: 'trunk' }, approver: { alwaysEscalate: ['x'] } }, fields: { 'approver.alwaysEscalate': ['x'], repos: [], downstream: DOWNSTREAM }, removed: ['policy'], note: ONLY_VERSION },
  { from: 6, input: { schemaVersion: 6, git: { base: 'trunk' }, daemon: { maxConcurrent: 2 } }, fields: { 'daemon.maxConcurrent': 2, repos: [], downstream: DOWNSTREAM }, removed: ['retention'], note: ONLY_VERSION },
  { from: 7, input: { schemaVersion: 7, git: { base: 'trunk' }, retention: { jobsDays: 30 } }, fields: { 'retention.jobsDays': 30, repos: [], downstream: DOWNSTREAM }, removed: ['notify'], note: ONLY_VERSION },
  { from: 8, input: { schemaVersion: 8, git: { base: 'trunk' }, notify: { webhooks: [], command: null } }, fields: { notify: { webhooks: [], command: null }, repos: [], downstream: DOWNSTREAM }, removed: ['budget'], note: ONLY_VERSION },
  {
    from: 9,
    input: { schemaVersion: 9, services: [SERVICE] },
    fields: { components: [{ ...SERVICE, kind: 'service', dependsOn: [] }], repos: [], downstream: DOWNSTREAM },
    removed: ['services'],
    note: 'each service becomes a service component with no dependencies',
  },
  { from: 10, input: { schemaVersion: 10, tracker: { kind: 'none' }, components: [] }, fields: { components: [], repos: [], downstream: DOWNSTREAM }, note: 'member repos start empty' },
  { from: 11, input: { schemaVersion: 11, repos: REPOS, components: LINKED }, fields: { repos: REPOS, components: LINKED, downstream: DOWNSTREAM }, note: 'dependsOn links are kept as written' },
  { from: 12, input: { schemaVersion: 12, repos: REPOS, components: LINKED, aiAttribution: 'forbid' }, fields: { components: LINKED, aiAttribution: 'forbid', downstream: DOWNSTREAM }, removed: ['release'], note: ONLY_VERSION },
  { from: 13, input: { schemaVersion: 13, repos: REPOS, git: { base: 'trunk' } }, fields: { repos: REPOS, 'git.base': 'trunk', downstream: DOWNSTREAM }, note: 'gains the downstream default' },
  { from: 14, input: { schemaVersion: 14, git: { base: 'trunk' }, components: [], repos: [], downstream: DOWNSTREAM }, fields: { 'git.base': 'trunk', downstream: DOWNSTREAM }, removed: ['checkout'], note: ONLY_VERSION },
  { from: 15, input: { schemaVersion: 15, release: { interim: 'canary' }, checkout: [] }, fields: { release: { interim: 'canary' }, checkout: [] }, removed: ['release.mechanism'], note: ONLY_VERSION },
  {
    from: 16,
    input: { schemaVersion: 16, release: { interim: 'canary', mechanism: 'tag', command: 'git tag v1' }, repos: [{ ...REPOS[0], release: { mechanism: 'changesets' } }] },
    fields: { release: { interim: 'canary', mechanism: 'tag', command: 'git tag v1' }, 'repos.0.release': { mechanism: 'changesets' } },
    removed: ['release.publish'],
    note: ONLY_VERSION,
  },
  { from: 17, input: { schemaVersion: 17, foreman: { enabled: true, reserved: ['secret'] } }, fields: { foreman: { enabled: true, reserved: ['secret', 'gate:release'] } }, note: 'a written-out reserved list gains gate:release' },
  { from: 18, input: { schemaVersion: 18, git: { base: 'trunk' }, foreman: { reserved: ['secret'] } }, fields: { 'foreman.reserved': ['secret'], 'git.base': 'trunk' }, removed: ['backing'], note: 'a v18 reserved list is left as written' },
  { from: 19, input: { schemaVersion: 19, components: SINKS }, fields: { components: SINKS }, note: ONLY_VERSION },
  {
    from: 20,
    input: { schemaVersion: 20, tracker: { kind: 'none' }, runtime: { models: { builder: 'opus' } }, review: { onPrFeedback: 'full' } },
    fields: { 'runtime.models': { builder: 'opus' }, review: { onPrFeedback: 'full' } },
    removed: ['runtime.modelByComplexity', 'runtime.reworkModel', 'review.onRework'],
    note: ONLY_VERSION,
  },
  {
    from: 21,
    input: { schemaVersion: 21, git: { base: 'trunk' }, backing: [{ name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] }] },
    fields: { backing: [{ name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] }] },
    removed: ['backing.0.database'],
    note: ONLY_VERSION,
  },
  { from: 22, input: { schemaVersion: 22, tracker: { kind: 'none' }, backing: [] }, fields: { backing: [], 'tracker.kind': 'none' }, removed: ['secrets'], note: ONLY_VERSION },
  { from: 23, input: { schemaVersion: 23, tracker: { kind: 'none' }, secrets: {}, outcomes: { windowDays: 7 } }, fields: { secrets: {}, outcomes: { windowDays: 7 } }, note: 'a written outcome window is kept' },
  { from: 24, input: { schemaVersion: 24, tracker: { kind: 'none' }, outcomes: { windowDays: 14 } }, fields: { outcomes: { windowDays: 14 } }, removed: ['environments'], note: ONLY_VERSION },
  { from: 25, input: { schemaVersion: 25, tracker: { kind: 'none' } }, fields: { 'tracker.kind': 'none' }, removed: ['scoring'], note: ONLY_VERSION },
  {
    from: 26,
    input: { schemaVersion: 26, pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } },
    fields: { pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } },
    removed: ['pipeline.maxTotalRounds', 'pr.maxCiReworks', 'daemon.jobBudget'],
    note: ONLY_VERSION,
  },
  { from: 27, input: { schemaVersion: 27, daemon: { enabled: true } }, fields: { daemon: { enabled: true } }, removed: ['daemon.turnTimeoutMinutes'], note: ONLY_VERSION },
];

const JOB_ROWS: Row[] = [
  {
    from: 1,
    input: { schemaVersion: 1, id: 'x', verify: { 1: 'FAIL', 2: 'PASS' } },
    fields: { verifyRuns: [run(1, 1, false), run(2, 1, true)], 'verify.1': 'FAIL', verifyRetries: { 1: 1 }, outcome: null, score: null },
    note: 'per-round results become attempt 1 with no sha; a v1 job walks every later migration',
  },
  {
    from: 2,
    input: { schemaVersion: 2, id: 'x', verifyRuns: [run(1, 1, false), run(1, 2, false), run(1, 3, true), run(2, 1, false), run(2, 2, true)] },
    fields: { verifyRetries: { 1: 2, 2: 1 }, budget: { limits: {}, ack: {}, lastCheck: null }, 'verifyRuns.length': 5 },
    note: 'failed verifies per round are recovered from the run history',
  },
  { from: 3, input: { schemaVersion: 3, id: 'x' }, fields: { noIssue: null } },
  {
    from: 4,
    input: {
      schemaVersion: 4,
      id: 'x',
      agents: { builder: { runs: 1, status: 'done', agentId: 'a1', endedAt: '2026-10-01T10:02:00.000Z' }, 'reviewer:code': { runs: 1, status: 'running', agentId: null, endedAt: null } },
    },
    fields: { 'agents.builder.importedThrough': { a1: '2026-10-01T10:02:00.000Z' } },
    removed: ['agents.reviewer:code.importedThrough'],
    note: 'an ended agent gains an import cursor at its end',
  },
  {
    from: 5,
    input: { schemaVersion: 5, id: 'x', agents: AGENTS, verifyRuns: [run(1, 1, false, 'abc')] },
    fields: { splitMode: null, effort: null, agents: AGENTS, verifyRuns: [run(1, 1, false, 'abc')] },
  },
  { from: 6, input: { schemaVersion: 6, id: 'x' }, fields: { effort: null } },
  {
    from: 7,
    input: { schemaVersion: 7, id: 'x', effort: 'high', state: 'waiting', waitingOn: 'escalation', reason: 'r' },
    fields: { effort: 'high', state: 'waiting', waitingOn: 'escalation', reason: 'r' },
    removed: ['_unsupported'],
    note: 'v8 only adds the human gate',
  },
  { from: 8, input: { schemaVersion: 8, id: 'x' }, fields: { complexity: null } },
  { from: 9, input: { schemaVersion: 9, id: 'x' }, fields: { protectedPaths: null } },
  {
    from: 10,
    input: { schemaVersion: 10, id: 'x', source: { tracker: 'github', ref: '12', url: 'https://github.com/acme/web/issues/12' } },
    fields: { issues: [{ tracker: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/issues/12' }] },
    removed: ['source'],
  },
  {
    from: 11,
    input: { schemaVersion: 11, id: 'x', branch: 'forge/x', base: 'main', worktree: '/tmp/x.worktrees/j', pr: PR },
    fields: { repos: [{ repo: null, worktree: '/tmp/x.worktrees/j', branch: 'forge/x', base: 'main', pr: PR, verifyOnly: false, interim: null }], interim: null, ports: {}, outcome: null, score: null },
    note: 'a v11 job becomes a one-repo job',
  },
  {
    from: 12,
    input: { schemaVersion: 12, id: 'x', branch: 'forge/x', base: 'main', repos: [{}, { repo: 'lib', worktree: null, base: 'main', pr: null, verifyOnly: false }] },
    fields: { interim: null, 'repos.0.interim': null, 'repos.1.interim': null, 'repos.1.repo': 'lib' },
  },
  { from: 13, input: { schemaVersion: 13, id: 'x', port: 4103 }, fields: { ports: {}, port: 4103 }, note: 'read as not allocated until the next worktree create' },
  { from: 14, input: { schemaVersion: 14, id: 'x', state: 'done', pr: { number: 1, state: 'MERGED' } }, fields: { outcome: null, state: 'done' } },
  { from: 15, input: { schemaVersion: 15, id: 'x', state: 'done', pr: { number: 1, state: 'MERGED' }, outcome: null }, fields: { score: null, outcome: null } },
  {
    from: 16,
    input: { schemaVersion: 16, id: 'x', title: 'Old', state: 'running', owner: OWNER },
    fields: { lease: { driver: 'S-old', epoch: 1, since: OWNER.since, renewedAt: OWNER.heartbeat, expiresAt: '2026-10-01T11:30:00.000Z' }, state: 'running' },
    removed: ['owner'],
    note: 'the owner keeps driving as epoch 1 for the 30 minutes its heartbeat gave it',
  },
];

const EVENT_ROWS: Row[] = [
  {
    from: 1,
    input: { v: 1, ts: 't', type: 'human', action: 'approve', actor: 'foreman' },
    fields: { actor: FOREMAN, action: 'approve', type: 'human', ts: 't' },
    note: 'a legacy actor string becomes the { login, source } object',
  },
  {
    from: 2,
    input: { v: 2, ts: 't', type: 'agent-start', role: 'builder', model: 'opus', output: 'build.md', actor: { login: 'al', source: 'env' } },
    fields: { type: 'agent-start', ts: 't', role: 'builder', model: 'opus', output: 'build.md', actor: { login: 'al', source: 'env' } },
    removed: ['pluginHash', 'promptHash', 'configHash'],
    note: 'an agent-start from before provenance keeps every field and gains no hash',
  },
];

const TABLES: [string, Row[], number, (input: Record<string, unknown>) => { out: any; from: unknown }][] = [
  [
    'config',
    CONFIG_ROWS,
    CONFIG_SCHEMA_VERSION,
    (input) => {
      const m = migrateConfig(input);
      return { out: m.config, from: m.from };
    },
  ],
  ['job', JOB_ROWS, JOB_SCHEMA_VERSION, (input) => ({ out: normalizeJob(input), from: undefined })],
  ['event', EVENT_ROWS, EVENT_SCHEMA_VERSION, (input) => ({ out: normalizeEvent(input), from: undefined })],
];

for (const [name, rows, current, read] of TABLES) {
  for (const row of rows) {
    test(`${name} v${row.from} → v${row.from + 1}`, () => {
      const { out, from } = read(structuredClone(row.input));
      if (name === 'config') assert.equal(from, row.from, 'migratedFrom names the old version');
      assert.equal(out[name === 'event' ? 'v' : 'schemaVersion'], current, 'reaches the current version');
      for (const [p, want] of Object.entries(row.fields)) assert.deepStrictEqual(get(out, p), want, p);
      for (const p of row.removed ?? []) assert.equal(get(out, p), MISSING, `${p} is absent`);
    });
  }
}

test('every migration has a table row', () => {
  const problems: string[] = [];
  for (const [name, rows, current] of TABLES) {
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.from)) problems.push(`${name} migration table has two rows for v${row.from}`);
      seen.add(row.from);
      if (row.from < 1 || row.from >= current) problems.push(`${name} migration table has a row for v${row.from}, outside 1..${current - 1}`);
      if (!Object.keys(row.fields).length && !row.removed?.length && !row.note?.trim())
        problems.push(`${name} v${row.from} row checks nothing: add a note saying the migration only bumps the version`);
    }
    for (let v = 1; v < current; v++) if (!seen.has(v)) problems.push(`${name} migration table has no row for v${v} (v${v} → v${v + 1})`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
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
