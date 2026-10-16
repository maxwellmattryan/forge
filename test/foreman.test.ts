// The foreman (issue: an office session that decides gates through assistant sub-agents): config v5,
// the `actor` audit field, gate requests and their routing, `forge job assist`, the CLI's authority
// checks on `--actor foreman`, the office scope's refusals, and the prompt and procedure contracts.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { TRUST_ENV, autoMerge, defaults, loadConfig, trustDigest, validateConfig } from '../lib/config.ts';
import { FIELDS } from '../lib/config-fields.ts';
import { INVALID_RESERVED, gateOwner, reservedMatch } from '../lib/foreman.ts';
import { createJob, jobDir, loadJob, logEvent, readEvents, setJob } from '../lib/jobs.ts';
import { syncPr } from '../lib/pr.ts';
import { OFFICE_SCOPE, listRequests, requestScope } from '../lib/requests.ts';
import { CONFIG_SCHEMA_VERSION, EFFORT_ROLES, OFFICE_GATES, migrateConfig } from '../lib/schema.ts';
import { computeStats } from '../lib/stats.ts';
import { roleBrief } from '../lib/brief.ts';
import * as yaml from '../lib/yaml.ts';
import { fixture } from './step-fixture.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** Rewrites .forge/config.yml with `edit` applied to its parsed form. */
function configure(dir: string, edit: (c: any) => void): void {
  const file = path.join(dir, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
}

/** A scratch repo with the foreman on (or as `edit` leaves it), and CLI helpers per scope. */
function scratch(edit: (c: any) => void = () => {}) {
  const r = repo();
  configure(r.dir, (c) => {
    c.foreman.enabled = true;
    edit(c);
  });
  const root = r.dir;
  const env = (scope?: string): NodeJS.ProcessEnv => (scope ? { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope, [TRUST_ENV]: trustDigest(root) } : { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined });
  const cli = async (scope: string | undefined, ...args: string[]) => {
    const res = await forgeAsync(root, args, env(scope));
    return { code: res.status, out: `${res.stdout}${res.stderr}`, json: () => JSON.parse(res.stdout) };
  };
  const job = (title: string, at?: Parameters<typeof setJob>[2]) => {
    const id = createJob(root, defaults(), { title }).id;
    if (at) setJob(root, id, at);
    return id;
  };
  const gates = (id?: string) => listRequests(root).filter((q) => q.type === 'gate' && (!id || q.job === id));
  const snapshot = (id: string) => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, id), f), 'utf8')).join('\0');
  return { root, cli, job, gates, snapshot, cleanup: r.cleanup, config: () => loadConfig(root).config };
}

const WAIT_SPEC = { stage: 'spec' as const, state: 'waiting' as const, waitingOn: 'spec-approval' as const, reason: 'spec ready' };

test('config v4 migrates to v5 with foreman defaults off', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 5);
  const v4 = { schemaVersion: 4, git: { base: 'trunk' }, runtime: { models: { builder: 'sonnet' } } };
  const { config, from } = migrateConfig(structuredClone(v4));
  assert.equal(from, 4);
  assert.deepEqual(config, { ...v4, schemaVersion: 5 }, 'nothing but schemaVersion changes');
  const d = defaults();
  assert.deepEqual(d.foreman, { enabled: false, decides: [...OFFICE_GATES], reserved: d.foreman.reserved, ship: 'propose' });
  assert.deepEqual(OFFICE_GATES, ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback']);
  for (const p of ['credentials', 'auth', 'permissions', 'security', 'CI/CD', 'token']) assert.ok(d.foreman.reserved.includes(p), p);
  assert.equal(d.runtime.models.assistant, 'sonnet');
  assert.equal(d.runtime.efforts.assistant, null);
  assert.ok((EFFORT_ROLES as readonly string[]).includes('assistant'));
  assert.equal(autoMerge(d), false);
});

test('foreman config keys are locked', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  for (const key of ['foreman.enabled', 'foreman.decides', 'foreman.reserved', 'foreman.ship']) {
    const f = FIELDS.find((x) => x.key === key);
    assert.ok(f, key);
    assert.equal(f!.editable, false, key);
    assert.ok(f!.lockedReason, `${key} says why`);
  }
  for (const key of ['runtime.models.assistant', 'runtime.efforts.assistant']) assert.equal(FIELDS.find((x) => x.key === key)?.editable, true, key);
  assert.match(docs, /^## Foreman$/m);
  for (const s of ['foreman:', 'decides:', 'reserved:', 'ship:', 'assistant: sonnet', 'assistant: null']) assert.ok(docs.includes(s), s);
  const bad: any = defaults();
  bad.foreman = { enabled: 'yes', decides: ['spec-approval', 'input'], reserved: ['ok', ''], ship: 'always' };
  const problems = validateConfig(bad, ROOT).filter((p) => p.startsWith('foreman'));
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('"input" is not a gate class')));
  assert.ok(problems.some((p) => p.startsWith('foreman.reserved must be a list of non-empty strings')));
  assert.ok(problems.some((p) => p.startsWith('foreman.ship must be one of propose | merge')));
  assert.deepEqual(validateConfig(defaults(), ROOT).filter((p) => p.startsWith('foreman')), []);
});

test('stats separate foreman decisions from human reworks', () => {
  const s = scratch();
  try {
    const id = s.job('Stats');
    logEvent(s.root, id, 'human', { action: 'rework', note: 'old event, no actor' });
    logEvent(s.root, id, 'human', { action: 'rework', note: 'a person', actor: 'human' });
    logEvent(s.root, id, 'human', { action: 'rework', note: 'the foreman', actor: 'foreman' });
    logEvent(s.root, id, 'human', { action: 'approve-spec', note: 'the foreman', actor: 'foreman' });
    const q = computeStats(s.root).quality;
    assert.equal(q.humanReworks, 2);
    assert.equal(q.foremanDecisions, 2);
    assert.equal(q.foremanReworks, 1);
    assert.equal(q.specFirstApprovalRate, 1, 'spec approval counts whoever approved');
  } finally {
    s.cleanup();
  }
});

test('reserved patterns match whole phrases, case-insensitively, and fail closed', () => {
  const c = defaults();
  assert.equal(reservedMatch(c, ['Rotate the CREDENTIALS file']), 'credentials');
  assert.equal(reservedMatch(c, ['the tokenizer is slow', 'authored by bob', 'cicada']), null, 'no partial words');
  assert.equal(reservedMatch(c, ['fix the CI/CD job']), 'CI');
  assert.equal(reservedMatch(c, ['touches GitHub Actions']), 'GitHub Actions');
  assert.equal(reservedMatch(c, [null, undefined, '']), null);
  // A hostile 10k-character line is matched in linear time.
  const t0 = Date.now();
  assert.equal(reservedMatch(c, ['a'.repeat(10_000) + '!'.repeat(10_000)]), null);
  assert.ok(Date.now() - t0 < 500, 'linear');
  for (const bad of [null, 'credentials', [''], [1], {}]) {
    const x: any = defaults();
    x.foreman.reserved = bad;
    assert.equal(reservedMatch(x, ['nothing here']), INVALID_RESERVED, JSON.stringify(bad));
  }
});

test('approver brief reflects ship merge', () => {
  const line = (edit: (c: any) => void) => roleBrief(fixture({ config: edit }), 'approver').extra.find((l) => l.startsWith('Merge: auto'));
  assert.match(line((c) => Object.assign(c.foreman, { enabled: true, ship: 'merge' }))!, /^Merge: auto true/);
  assert.match(line((c) => Object.assign(c.foreman, { enabled: true, ship: 'propose' }))!, /^Merge: auto false/);
  assert.match(line((c) => Object.assign(c.foreman, { enabled: false, ship: 'merge' }))!, /^Merge: auto false/);
  assert.match(line((c) => (c.merge.auto = true))!, /^Merge: auto true/);
});

describe('foreman CLI', { concurrency: 4 }, () => {
  test('human events record actor, old events read as human', async () => {
    const s = scratch();
    try {
      const id = s.job('Actor');
      const r = await s.cli(undefined, 'job', 'human', id, 'rework', '--note', 'x');
      assert.equal(r.code, 0, r.out);
      const ev = readEvents(s.root, id).filter((e) => e.type === 'human');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].actor, 'human');
      assert.equal(ev[0].note, 'x');
      const bad = await s.cli(undefined, 'job', 'human', id, 'rework', '--actor', 'robot');
      assert.notEqual(bad.code, 0);
      logEvent(s.root, id, 'human', { action: 'rework' });
      assert.equal(computeStats(s.root).quality.humanReworks, 2, 'an event without actor reads as human');
    } finally {
      s.cleanup();
    }
  });

  test('park at a decided gate enqueues one gate request routed to _office', async () => {
    const s = scratch();
    try {
      const id = s.job('Park', { stage: 'spec', state: 'running' });
      const park = () => s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready');
      const r = await park();
      assert.equal(r.code, 0, r.out);
      let g = s.gates(id);
      assert.equal(g.length, 1);
      assert.deepEqual(g[0].args, { gate: 'spec-approval', reserved: null });
      assert.equal(g[0].from, 'forge');
      assert.equal(g[0].status, 'pending');
      assert.equal(r.json().gateRequest, g[0].id);
      assert.equal(requestScope(s.root, g[0]), OFFICE_SCOPE);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'foreman');
      // The same park again, and a re-park after leaving the gate: no second request while the first is pending.
      assert.equal((await park()).code, 0);
      assert.equal((await s.cli(undefined, 'job', 'set', id, '--state', 'running')).code, 0);
      assert.equal((await park()).code, 0);
      g = s.gates(id);
      assert.equal(g.length, 1, 'still one');
      // A gate the foreman never decides writes nothing.
      const input = s.job('Input', { stage: 'build', state: 'running' });
      assert.equal((await s.cli(undefined, 'job', 'set', input, '--state', 'waiting', '--waiting-on', 'input')).code, 0);
      assert.deepEqual(s.gates(input), []);
    } finally {
      s.cleanup();
    }
  });

  test('no gate request with the foreman off or the class not decided', async () => {
    for (const edit of [(c: any) => (c.foreman.enabled = false), (c: any) => (c.foreman.decides = ['escalation'])]) {
      const s = scratch(edit);
      try {
        const id = s.job('Off', { stage: 'spec', state: 'running' });
        const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'spec-approval');
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(s.gates(), []);
        assert.equal('gateRequest' in r.json(), false);
      } finally {
        s.cleanup();
      }
    }
  });

  test('reserved escalation is marked reserved and fails closed', async () => {
    const s = scratch();
    try {
      const id = s.job('Reserved', { stage: 'decide', state: 'running' });
      const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated: rotate Credentials');
      assert.equal(r.code, 0, r.out);
      const [g] = s.gates(id);
      assert.deepEqual(g.args, { gate: 'escalation', reserved: 'credentials' });
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'human');
      // decision.md's Why section counts for escalations.
      const id2 = s.job('Decision', { stage: 'decide', state: 'running' });
      fs.writeFileSync(path.join(jobDir(s.root, id2), 'decision.md'), 'ESCALATE: risky\n\n## Why\n- changes the OAuth callback\n## For the human\n- check it\n');
      await s.cli(undefined, 'job', 'set', id2, '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated: see decision.md');
      assert.equal(s.gates(id2)[0].args.reserved, 'oauth');
      // An unreadable foreman.reserved: every gate is reserved.
      configure(s.root, (c) => (c.foreman.reserved = 'credentials'));
      const id3 = s.job('Invalid', { stage: 'spec', state: 'running' });
      await s.cli(undefined, 'job', 'set', id3, '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready');
      assert.equal(s.gates(id3)[0].args.reserved, INVALID_RESERVED);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id3)), 'human');
    } finally {
      s.cleanup();
    }
  });

  test('assist brief names paths only', async () => {
    const s = scratch();
    try {
      const id = s.job('Assist', WAIT_SPEC);
      const SENTINEL = 'SENTINEL-do-not-leak-7f3a';
      for (const f of ['spec.md', 'plan.md', 'pr-feedback.md']) fs.writeFileSync(path.join(jobDir(s.root, id), f), `# x\n${SENTINEL}\n`);
      const r = await s.cli(undefined, 'job', 'assist', id, '--gate', 'spec-approval');
      assert.equal(r.code, 0, r.out);
      assert.equal(r.out.includes(SENTINEL), false, 'no file content in the output');
      const a = r.json();
      assert.deepEqual(Object.keys(a).sort(), ['brief', 'effort', 'gate', 'model', 'reserved', 'stale', 'subagent']);
      assert.equal(a.gate, 'spec-approval');
      assert.equal(a.stale, false);
      assert.equal(a.reserved, null);
      assert.equal(a.model, 'sonnet');
      assert.equal(a.effort, null);
      assert.equal(a.subagent, 'forge:assistant');
      const dir = jobDir(s.root, id);
      for (const p of ['spec.md', 'plan.md', 'decision.md', path.join('review', 'round-1'), 'pr-feedback.md', path.join('verify', 'round-0.md'), 'feedback.md']) assert.ok(a.brief.includes(path.join(dir, p)), p);
      assert.match(a.brief, /^Gate: spec-approval$/m);
      assert.match(a.brief, /^Reserved: \["credential",/m);
      assert.match(a.brief, /^Untrusted: /m);
      // Read-only: nothing new in the job dir.
      assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'job.json', 'plan.md', 'pr-feedback.md', 'request.md', 'spec.md'].filter((f) => fs.existsSync(path.join(dir, f))).sort());
      // A job session may not ask for it.
      assert.equal((await s.cli(id, 'job', 'assist', id, '--gate', 'spec-approval')).code, 1);
      assert.equal((await s.cli(OFFICE_SCOPE, 'job', 'assist', id, '--gate', 'spec-approval')).code, 0);
    } finally {
      s.cleanup();
    }
  });

  test('assist reports stale and refuses unknown gates', async () => {
    const s = scratch();
    try {
      const id = s.job('Stale', WAIT_SPEC);
      const r = await s.cli(undefined, 'job', 'assist', id, '--gate', 'escalation');
      assert.equal(r.code, 0, r.out);
      assert.equal(r.json().stale, true);
      for (const gate of ['input', 'pr-review', '../x']) {
        const bad = await s.cli(undefined, 'job', 'assist', id, '--gate', gate);
        assert.equal(bad.code, 1, gate);
        assert.match(bad.out, /--gate must be one of/);
      }
      assert.equal((await s.cli(undefined, 'job', 'assist', id)).code, 1, 'no --gate');
    } finally {
      s.cleanup();
    }
  });

  test('foreman records a decision and hands off with resume', async () => {
    const s = scratch();
    try {
      const id = s.job('Decide', WAIT_SPEC);
      const r = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve-spec', '--actor', 'foreman', '--note', 'ok');
      assert.equal(r.code, 0, r.out);
      const ev = readEvents(s.root, id).filter((e) => e.type === 'human');
      assert.deepEqual(ev.map((e) => [e.action, e.actor, e.note]), [['approve-spec', 'foreman', 'ok']]);
      const h = await s.cli(OFFICE_SCOPE, 'requests', 'add', 'resume', '--job', id);
      assert.equal(h.code, 0, h.out);
      assert.equal(h.json().from, 'daemon:_office');
      assert.equal(h.json().type, 'resume');
    } finally {
      s.cleanup();
    }
  });

  test('foreman authority is enforced by the CLI', async () => {
    const s = scratch((c) => (c.foreman.decides = ['spec-approval', 'escalation']));
    try {
      const refused = async (id: string, scope: string | undefined, args: string[], why: RegExp, label: string) => {
        const before = s.snapshot(id);
        const r = await s.cli(scope, 'job', 'human', id, ...args);
        assert.equal(r.code, 1, `${label}: ${r.out}`);
        assert.match(r.out, why, label);
        assert.equal(s.snapshot(id), before, `${label}: job.json and events.jsonl untouched`);
      };
      const spec = s.job('Spec', WAIT_SPEC);
      const foreman = ['--actor', 'foreman', '--note', 'ok'];
      await refused(spec, undefined, ['approve-spec', ...foreman], /only the office daemon session/, 'outside _office');
      await refused(spec, spec, ['approve-spec', ...foreman], /only the office daemon session/, 'from a job session');
      await refused(spec, '_inbox', ['approve-spec', ...foreman], /only the office daemon session/, 'from the inbox');
      await refused(spec, OFFICE_SCOPE, ['approve-spec', '--note', 'ok'], /only with --actor foreman/, 'in _office without --actor');
      await refused(spec, OFFICE_SCOPE, ['approve-spec', '--actor', 'human', '--note', 'ok'], /only with --actor foreman/, 'in _office with --actor human');
      const running = s.job('Running', { stage: 'build', state: 'running' });
      await refused(running, OFFICE_SCOPE, ['rework', ...foreman], /not waiting on a gate the foreman decides/, 'not waiting');
      const split = s.job('Split', { stage: 'plan', state: 'waiting', waitingOn: 'split-approval' });
      await refused(split, OFFICE_SCOPE, ['approve-split', ...foreman], /split-approval is not in foreman.decides/, 'class missing from decides');
      const input = s.job('Input', { stage: 'build', state: 'waiting', waitingOn: 'input' });
      await refused(input, OFFICE_SCOPE, ['answer', ...foreman], /not waiting on a gate the foreman decides/, 'a gate the foreman never decides');
      const reason = s.job('Reason', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: new auth flow' });
      await refused(reason, OFFICE_SCOPE, ['approve', ...foreman], /reserved \(auth\)/, 'reason matches');
      const dec = s.job('Dec', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: see decision.md' });
      fs.writeFileSync(path.join(jobDir(s.root, dec), 'decision.md'), 'ESCALATE: x\n\n## Risk\n- secrets here do not count\n## For the human\n- check the GitHub Actions workflow\n');
      await refused(dec, OFFICE_SCOPE, ['approve', ...foreman], /reserved \(workflow\)|reserved \(GitHub Actions\)/, 'decision.md matches');
      const clean = s.job('Clean', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: naming' });
      await refused(clean, OFFICE_SCOPE, ['approve', '--actor', 'foreman', '--note', 'fine, only the password field label'], /reserved \(password\)/, 'note matches');
      await refused(spec, OFFICE_SCOPE, ['approve', ...foreman], /approve is not a spec-approval action/, 'off-class action');
      await refused(spec, OFFICE_SCOPE, ['answer', ...foreman], /answer is not a spec-approval action/, 'answer');
      await refused(spec, OFFICE_SCOPE, ['approve-spec', ...foreman, '--link', 'none'], /linking an issue stays a human call/, '--link');
      await refused(spec, OFFICE_SCOPE, ['approve-spec', '--actor', 'foreman'], /needs --note/, 'no note');
      // A decision.md that can't be read safely counts as reserved.
      const link = s.job('Link', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: naming' });
      fs.symlinkSync(path.join(s.root, 'README.md'), path.join(jobDir(s.root, link), 'decision.md'));
      await refused(link, OFFICE_SCOPE, ['approve', ...foreman], /unreadable decision.md/, 'symlinked decision.md');
      // And the clean escalation goes through.
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'human', clean, 'approve', ...foreman);
      assert.equal(ok.code, 0, ok.out);
    } finally {
      s.cleanup();
    }
  });

  test('office scope cannot drive, claim or merge', async () => {
    const s = scratch();
    try {
      const id = s.job('Drive', { stage: 'build', state: 'running' });
      const before = s.snapshot(id);
      for (const args of [
        ['worktree', 'create', id],
        ['job', 'agent', id, 'start', '--role', 'builder'],
        ['job', 'advance', id, '--session', 'office'],
        ['job', 'claim', id, '--session', 'office'],
        ['pr', 'merge', id],
      ]) {
        const r = await s.cli(OFFICE_SCOPE, ...args);
        assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
        assert.match(r.out, /the office session decides gates and does not drive jobs/, args.join(' '));
      }
      assert.equal(s.snapshot(id), before);
      for (const scope of [undefined, OFFICE_SCOPE]) {
        const g = await s.cli(scope, 'requests', 'add', 'gate', '--job', id);
        assert.equal(g.code, 1, g.out);
        assert.match(g.out, /gate requests are written only by/);
      }
      assert.deepEqual(s.gates(), []);
    } finally {
      s.cleanup();
    }
  });
});

// Mutates process.env (PATH, the stub's answers), so it runs on its own, outside the concurrent block.
test('pr feedback enqueues one gate per head', { skip: process.platform === 'win32' }, () => {
  const s = scratch((c) => (c.tracker.github = { ...(c.tracker.github ?? {}), repo: 'o/r' }));
  const bin = path.join(s.root, '..', `fakebin-${path.basename(s.root)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"headRefOid":"%s","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"CHANGES_REQUESTED","statusCheckRollup":[],"mergedAt":null,"closedAt":null,"headRefName":"forge/x","baseRefName":"main"}' "$FAKE_HEAD_OID" ;;
  "repo view") echo o/r ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"state":"CHANGES_REQUESTED","body":"please fix","author":{"login":"alice"},"authorAssociation":"OWNER","submittedAt":"2026-10-15T00:00:00Z","url":"u"}]}}}}}' ;;
esac
`,
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, FAKE_HEAD_OID: process.env.FAKE_HEAD_OID };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  try {
    const config = s.config();
    const id = s.job('Feedback', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
    const head1 = 'a'.repeat(40);
    process.env.FAKE_HEAD_OID = head1;
    syncPr(s.root, config, id);
    let g = s.gates(id);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].args, { gate: 'pr-feedback', key: head1, reserved: null });
    syncPr(s.root, config, id);
    assert.equal(s.gates(id).length, 1, 'the same head enqueues nothing more');
    process.env.FAKE_HEAD_OID = 'b'.repeat(40);
    syncPr(s.root, config, id);
    g = s.gates(id);
    assert.equal(g.length, 2, 'a new push re-arms it');
    // A merge-time sync never routes, so it never enqueues.
    const off = { ...config, foreman: { ...config.foreman, decides: ['spec-approval' as const] } };
    process.env.FAKE_HEAD_OID = 'c'.repeat(40);
    syncPr(s.root, off, id);
    assert.equal(s.gates(id).length, 2, 'pr-feedback missing from decides writes nothing');
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_HEAD_OID === undefined) delete process.env.FAKE_HEAD_OID;
    else process.env.FAKE_HEAD_OID = saved.FAKE_HEAD_OID;
    fs.rmSync(bin, { recursive: true, force: true });
    s.cleanup();
  }
});

test('assistant prompt has every gate section and the contract', () => {
  const text = fs.readFileSync(path.join(ROOT, 'agents', 'assistant.md'), 'utf8');
  const front = text.split('---')[1];
  assert.match(front, /^name: assistant$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.match(front, /^disallowedTools: Edit, NotebookEdit$/m);
  for (const g of OFFICE_GATES) assert.match(text, new RegExp(`^## ${g}$`, 'm'), g);
  const untrusted = fs.readFileSync(path.join(ROOT, 'agents', 'builder.md'), 'utf8').split('\n').find((l) => l.startsWith('**Untrusted input.**'));
  assert.ok(untrusted && text.includes(untrusted), 'the untrusted-input paragraph, verbatim');
  assert.equal(text.trimEnd().split('\n').at(-1), 'Reply with exactly one line: `ASSIST: approve|revise|rework|escalate · <reason>`.');
});

test('foreman procedure names only CLI calls', () => {
  const ref = path.join(ROOT, 'skills', 'forge', 'reference');
  const text = fs.readFileSync(path.join(ref, 'foreman.md'), 'utf8');
  for (const s of ['forge job assist', '--actor foreman', 'forge requests add resume', 'forge requests claim', 'forge:assistant']) assert.ok(text.includes(s), s);
  for (const f of ['spec.md', 'plan.md', 'decision.md', 'pr-feedback.md', 'verify']) {
    assert.doesNotMatch(text, new RegExp(`\\b(Read|cat|head|tail|grep)\\b[^\\n|]*${f.replace('.', '\\.')}`), `no read of ${f}`);
  }
  for (const g of ['spec-approval', 'split-approval', 'escalation, rounds-exhausted', 'conflicts', 'pr-feedback']) assert.match(text, new RegExp(`^\\| ${g} \\|`, 'm'), g);
  assert.match(fs.readFileSync(path.join(ref, 'requests.md'), 'utf8'), /`scope: "office"`[^\n]*reference\/foreman\.md/);
  assert.match(fs.readFileSync(path.join(ROOT, 'skills', 'forge', 'SKILL.md'), 'utf8'), /With `foreman\.enabled`, the CLI turns gates into `gate` requests/);
});
