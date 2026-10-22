// The foreman (issue: an office session that decides gates through assistant sub-agents): config v5,
// the `actor` audit field, gate requests and their routing, `forge job assist`, the CLI's authority
// checks on `--actor foreman`, the office scope's refusals, and the prompt and procedure contracts.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, forgeInProcess, repoTemplate } from './helpers.ts';
import { TRUST_ENV, autoMerge, defaults, loadConfig, trustDigest, validateConfig } from '../lib/config.ts';
import { FIELDS } from '../lib/config-fields.ts';
import { INVALID_RESERVED, SECURITY_CHANGES, SECURITY_UNCLEAR, TOTAL_CEILING, checkForemanDecision, checkOfficeSetFor, gateClass, gateOwner, latestSecurityVerdict, maybeEnqueueGate, reservedFor, reservedMatch } from '../lib/foreman.ts';
import { ForgeError } from '../lib/util.ts';
import { createJob, jobDir, loadJob, logEvent, readEvents, setJob } from '../lib/jobs.ts';
import { checksText, failingCheckNames, syncPr, trustedFeedback } from '../lib/pr.ts';
import { loadStepInput, step } from '../lib/step.ts';
import { OFFICE_SCOPE, ackRequest, enqueue, listRequests, requestScope } from '../lib/requests.ts';
import { EFFORT_ROLES, OFFICE_GATES } from '../lib/schema.ts';
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
  const config = () => loadConfig(root).config;
  /**
   * The checks `forge job human <id> <action> --actor foreman` runs before any write, from `scope`
   * (undefined: outside the daemon), asserted to refuse with exit 1 and `why`.
   */
  const refusedDecision = (id: string, scope: string | undefined, action: string, note: string | undefined, why: RegExp, label: string, flags: { link?: unknown; reason?: unknown } = {}) =>
    assert.throws(() => checkForemanDecision(root, config(), loadJob(root, id), action, note, flags, scopeEnv(scope)), (e: unknown) => e instanceof ForgeError && e.exitCode === 1 && why.test(e.message), label);
  return { root, cli, job, gates, snapshot, refusedDecision, cleanup: r.cleanup, config };
}

/** The env of a daemon session in `scope`, for the functions that take one; undefined: no daemon. */
const scopeEnv = (scope?: string): NodeJS.ProcessEnv => (scope ? { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope } : {});

const WAIT_SPEC = { stage: 'spec' as const, state: 'waiting' as const, waitingOn: 'spec-approval' as const, reason: 'spec ready' };

test('foreman defaults are off and leave repo-proposal and release with a human', () => {
  const d = defaults();
  // repo-proposal widens the repos a job pushes to and release publishes, so the default leaves both with a human.
  assert.deepEqual(d.foreman, { enabled: false, decides: OFFICE_GATES.filter((g) => g !== 'repo-proposal' && g !== 'release'), reserved: d.foreman.reserved, ship: 'propose' });
  assert.deepEqual(OFFICE_GATES, ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release']);
  for (const p of ['credentials', 'auth', 'permissions', 'security', 'CI/CD', 'token']) assert.ok(d.foreman.reserved.includes(p), p);
  assert.equal(d.runtime.models.assistant, 'sonnet');
  assert.equal(d.runtime.efforts.assistant, null);
  assert.ok((EFFORT_ROLES as readonly string[]).includes('assistant'));
  assert.equal(autoMerge(d), false);
});

test('foreman config keys are locked', () => {
  for (const key of ['foreman.enabled', 'foreman.decides', 'foreman.reserved', 'foreman.ship']) {
    const f = FIELDS.find((x) => x.key === key);
    assert.ok(f, key);
    assert.equal(f!.editable, false, key);
    assert.ok(f!.lockedReason, `${key} says why`);
  }
  for (const key of ['runtime.models.assistant', 'runtime.efforts.assistant']) assert.equal(FIELDS.find((x) => x.key === key)?.editable, true, key);
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
    // A v1 events file as an older Forge wrote it: string actors, or none at all.
    const v1 = [
      { v: 1, ts: '2026-01-01T00:00:00Z', type: 'human', action: 'rework', note: 'old event, no actor' },
      { v: 1, ts: '2026-01-01T00:00:01Z', type: 'human', action: 'rework', note: 'a person', actor: 'human' },
      { v: 1, ts: '2026-01-01T00:00:02Z', type: 'human', action: 'rework', note: 'the foreman', actor: 'foreman' },
      { v: 1, ts: '2026-01-01T00:00:03Z', type: 'human', action: 'approve-spec', note: 'the foreman', actor: 'foreman' },
    ];
    fs.appendFileSync(path.join(jobDir(s.root, id), 'events.jsonl'), v1.map((e) => JSON.stringify(e) + '\n').join(''));
    let q = computeStats(s.root).quality;
    assert.equal(q.humanReworks, 2);
    assert.equal(q.foremanDecisions, 2);
    assert.equal(q.foremanReworks, 1);
    // And the v2 shapes beside them.
    logEvent(s.root, id, 'human', { action: 'rework', actor: { login: null, source: 'foreman' } });
    logEvent(s.root, id, 'human', { action: 'rework', actor: { login: 'alice', source: 'gh' } });
    q = computeStats(s.root).quality;
    assert.equal(q.humanReworks, 3);
    assert.equal(q.foremanReworks, 2);
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

test('trusted feedback counts only people with write access', () => {
  const c = (assoc: string, extra: Record<string, unknown> = {}) => ({ author: { login: 'u' }, authorAssociation: assoc, body: 'b', ...extra });
  assert.equal(trustedFeedback({ threads: [{ comments: { nodes: [c('NONE'), c('CONTRIBUTOR')] } }], reviews: [{ state: 'CHANGES_REQUESTED', ...c('FIRST_TIMER') }] }), 0);
  assert.equal(trustedFeedback({ threads: [{ comments: { nodes: [c('NONE'), c('MEMBER')] } }], reviews: [{ state: 'CHANGES_REQUESTED', ...c('OWNER') }, { state: 'COMMENTED', ...c('OWNER') }] }), 2);
  assert.equal(trustedFeedback({ threads: [{ comments: { nodes: [c('OWNER', { author: { login: 'ci[bot]' } }), c('OWNER', { body: '<!-- forge --> mine' })] } }], reviews: [] }), 0, "bots and Forge's own comments never count");
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
      assert.deepEqual(ev[0].actor, { login: 'forge-test', source: 'env' });
      assert.equal(ev[0].v, 2);
      assert.equal(ev[0].note, 'x');
      const bad = await s.cli(undefined, 'job', 'human', id, 'rework', '--actor', 'robot');
      assert.notEqual(bad.code, 0);
      fs.appendFileSync(path.join(jobDir(s.root, id), 'events.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), type: 'human', action: 'rework' }) + '\n');
      assert.equal(computeStats(s.root).quality.humanReworks, 2, 'an event without actor reads as human');
      assert.deepEqual(readEvents(s.root, id).at(-1)!.actor, { login: null, source: 'unknown' });
    } finally {
      s.cleanup();
    }
  });

  test('park at a decided gate enqueues one gate request routed to _office', async () => {
    const s = scratch();
    try {
      const id = s.job('Park', { stage: 'spec', state: 'running' });
      const parkArgs = ['job', 'set', id, '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready'];
      // The first park through the CLI, the repeats in-process.
      const park = async () => (await forgeInProcess(s.root, parkArgs)).status;
      const r = await s.cli(undefined, ...parkArgs);
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
      assert.equal(await park(), 0);
      assert.equal((await forgeInProcess(s.root, ['job', 'set', id, '--state', 'running'])).status, 0);
      assert.equal(await park(), 0);
      g = s.gates(id);
      assert.equal(g.length, 1, 'still one');
      // A gate the foreman never decides writes nothing.
      const input = s.job('Input', { stage: 'build', state: 'running' });
      assert.equal((await forgeInProcess(s.root, ['job', 'set', input, '--state', 'waiting', '--waiting-on', 'input'])).status, 0);
      assert.deepEqual(s.gates(input), []);
    } finally {
      s.cleanup();
    }
  });

  test('no gate request with the foreman off or the class not decided', async () => {
    // The foreman off: one park through the CLI, whose JSON has no gateRequest.
    const off = scratch((c) => (c.foreman.enabled = false));
    try {
      const id = off.job('Off', { stage: 'spec', state: 'running' });
      const r = await off.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'spec-approval');
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(off.gates(), []);
      assert.equal('gateRequest' in r.json(), false);
    } finally {
      off.cleanup();
    }
    // The class not decided: the park's own enqueue step.
    const s = scratch((c) => (c.foreman.decides = ['escalation']));
    try {
      const id = s.job('Undecided', { stage: 'spec', state: 'running' });
      const before = loadJob(s.root, id);
      const after = setJob(s.root, id, { state: 'waiting', waitingOn: 'spec-approval' });
      assert.equal(maybeEnqueueGate(s.root, s.config(), before, after), null);
      assert.deepEqual(s.gates(), []);
    } finally {
      s.cleanup();
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
      assert.equal((await forgeInProcess(s.root, ['job', 'set', id2, '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated: see decision.md'])).status, 0);
      assert.equal(s.gates(id2)[0].args.reserved, 'oauth');
      // An unreadable foreman.reserved: every gate is reserved.
      configure(s.root, (c) => (c.foreman.reserved = 'credentials'));
      const id3 = s.job('Invalid', { stage: 'spec', state: 'running' });
      assert.equal((await forgeInProcess(s.root, ['job', 'set', id3, '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready'])).status, 0);
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
      assert.match(a.brief, /^Release gate: none$/m);
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
        const bad = await forgeInProcess(s.root, ['job', 'assist', id, '--gate', gate]);
        assert.equal(bad.status, 1, gate);
        assert.match(String(bad.error?.message), /--gate must be one of/);
      }
      assert.equal((await forgeInProcess(s.root, ['job', 'assist', id])).status, 1, 'no --gate');
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
      assert.deepEqual(ev.map((e) => [e.action, e.actor, e.note]), [['approve-spec', { login: null, source: 'foreman' }, 'ok']]);
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
      const spec = s.job('Spec', WAIT_SPEC);
      // Through the CLI: a foreman decision outside _office, and a plain one inside it, are refused before any write.
      const before = s.snapshot(spec);
      const outside = await s.cli(undefined, 'job', 'human', spec, 'approve-spec', '--actor', 'foreman', '--note', 'ok');
      assert.equal(outside.code, 1, outside.out);
      assert.match(outside.out, /only the office daemon session/);
      assert.equal(s.snapshot(spec), before, 'outside _office: job.json and events.jsonl untouched');
      const plain = await s.cli(OFFICE_SCOPE, 'job', 'human', spec, 'approve-spec', '--note', 'ok');
      assert.equal(plain.code, 1, plain.out);
      assert.match(plain.out, /only with --actor foreman/);
      assert.equal(s.snapshot(spec), before, 'in _office without --actor: nothing written');
      // The rest are the checks `job human --actor foreman` runs before writing, called directly.
      const refused = (id: string, scope: string | undefined, action: string, note: string | undefined, why: RegExp, label: string, flags = {}) => s.refusedDecision(id, scope, action, note, why, label, flags);
      refused(spec, spec, 'approve-spec', 'ok', /only the office daemon session/, 'from a job session');
      refused(spec, '_inbox', 'approve-spec', 'ok', /only the office daemon session/, 'from the inbox');
      const running = s.job('Running', { stage: 'build', state: 'running' });
      refused(running, OFFICE_SCOPE, 'rework', 'ok', /not waiting on a gate the foreman decides/, 'not waiting');
      const split = s.job('Split', { stage: 'plan', state: 'waiting', waitingOn: 'split-approval' });
      refused(split, OFFICE_SCOPE, 'approve-split', 'ok', /split-approval is not in foreman.decides/, 'class missing from decides');
      const input = s.job('Input', { stage: 'build', state: 'waiting', waitingOn: 'input' });
      refused(input, OFFICE_SCOPE, 'answer', 'ok', /not waiting on a gate the foreman decides/, 'a gate the foreman never decides');
      const reason = s.job('Reason', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: new auth flow' });
      refused(reason, OFFICE_SCOPE, 'approve', 'ok', /reserved \(auth\)/, 'reason matches');
      const dec = s.job('Dec', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: see decision.md' });
      fs.writeFileSync(path.join(jobDir(s.root, dec), 'decision.md'), 'ESCALATE: x\n\n## Risk\n- secrets here do not count\n## For the human\n- check the GitHub Actions workflow\n');
      refused(dec, OFFICE_SCOPE, 'approve', 'ok', /reserved \(workflow\)|reserved \(GitHub Actions\)/, 'decision.md matches');
      const clean = s.job('Clean', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: naming' });
      refused(clean, OFFICE_SCOPE, 'approve', 'fine, only the password field label', /reserved \(password\)/, 'note matches');
      refused(spec, OFFICE_SCOPE, 'approve', 'ok', /approve is not a spec-approval action/, 'off-class action');
      refused(spec, OFFICE_SCOPE, 'answer', 'ok', /answer is not a spec-approval action/, 'answer');
      refused(spec, OFFICE_SCOPE, 'approve-spec', 'ok', /linking an issue stays a human call/, '--link', { link: 'none' });
      refused(spec, OFFICE_SCOPE, 'approve-spec', undefined, /needs --note/, 'no note');
      // A decision.md that can't be read safely counts as reserved.
      const link = s.job('Link', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: naming' });
      fs.symlinkSync(path.join(s.root, 'README.md'), path.join(jobDir(s.root, link), 'decision.md'));
      refused(link, OFFICE_SCOPE, 'approve', 'ok', /unreadable decision.md/, 'symlinked decision.md');
      // And the clean escalation goes through.
      const foreman = ['--actor', 'foreman', '--note', 'ok'];
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'human', clean, 'approve', ...foreman);
      assert.equal(ok.code, 0, ok.out);
    } finally {
      s.cleanup();
    }
  });

  test('office job set carries out only a recorded foreman decision', async () => {
    const s = scratch();
    try {
      const id = s.job('Set', WAIT_SPEC);
      // Through the CLI once: an office `job set` with no decision recorded, refused before any write.
      const before = s.snapshot(id);
      const none = await s.cli(OFFICE_SCOPE, 'job', 'set', id, '--state', 'running');
      assert.equal(none.code, 1, none.out);
      assert.match(none.out, /no foreman decision recorded/);
      assert.equal(s.snapshot(id), before, 'nothing written');
      // The rest are the check an office `job set` runs before its write, called directly.
      const refused = (jobId: string, change: Parameters<typeof checkOfficeSetFor>[2], why: RegExp, label: string) =>
        assert.throws(() => checkOfficeSetFor(s.root, loadJob(s.root, jobId), change), (e: unknown) => e instanceof ForgeError && e.exitCode === 1 && why.test(e.message), label);
      logEvent(s.root, id, 'human', { action: 'approve-spec', note: 'a person', actor: 'human' });
      refused(id, { state: 'running' }, /no foreman decision recorded/, "a human's decision is not the foreman's");
      assert.equal((await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve-spec', '--actor', 'foreman', '--note', 'ok')).code, 0);
      refused(id, { stage: 'build', state: 'running' }, /approve-spec moves the job to/, 'a stage outside the table');
      refused(id, { state: 'running', fields: { complexity: 'low' } }, /no --field/, '--field');
      refused(id, { state: 'running', reason: 'x' }, /no --waiting-on or --reason/, '--reason');
      refused(id, { state: 'done' }, /only --state running/, 'another state');
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'set', id, '--state', 'running');
      assert.equal(ok.code, 0, ok.out);
      refused(id, { stage: 'build', state: 'running' }, /is not waiting on a gate/, 'once carried out, nothing more');
      // A decision from before the current park doesn't count.
      const old = s.job('Old', { stage: 'build', state: 'running' });
      logEvent(s.root, old, 'human', { action: 'rework', note: 'x', actor: 'foreman' });
      await new Promise((r) => setTimeout(r, 5));
      setJob(s.root, old, { state: 'waiting', waitingOn: 'escalation', reason: 'again' });
      refused(old, { stage: 'build', state: 'running' }, /no foreman decision recorded/, 'a decision older than the park');
      // The job subcommands outside the office allowlist: 'office scope refusals, in-process' below.
    } finally {
      s.cleanup();
    }
  });

  test('a security review asking for changes lets the foreman mitigate but never approve', async () => {
    const s = scratch();
    try {
      const id = s.job('Sec', { stage: 'build', state: 'running', fields: { verdicts: { 1: { code: 'PASS', security: 'CHANGES' }, 2: { code: 'CHANGES' } } } });
      const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 3 exceeds maxRounds 2');
      assert.equal(r.code, 0, r.out);
      assert.equal(s.gates(id)[0].args.reserved, null, 'the gate reaches the assistant');
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'foreman');
      const assist = (await s.cli(undefined, 'job', 'assist', id, '--gate', 'rounds-exhausted')).json();
      assert.equal(assist.reserved, null);
      assert.match(assist.brief, /^Security review: \(security review: CHANGES\)\. Approving is refused while it stands: security always has to pass, so rework or revise to fix the findings\.$/m);
      const before = s.snapshot(id);
      const refused = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'cosmetic');
      assert.equal(refused.code, 1, refused.out);
      assert.match(refused.out, /security review: CHANGES/);
      assert.equal(s.snapshot(id), before);
      const fixed = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'rework', '--actor', 'foreman', '--note', 'fix the injection finding');
      assert.equal(fixed.code, 0, fixed.out);
      // A gate with no mitigating action (conflicts: approve only) stays a human's.
      const conflicted = s.job('Conflicted', { stage: 'pr', state: 'waiting', waitingOn: 'conflicts', fields: { verdicts: { 1: { security: 'CHANGES' } } } });
      assert.equal(reservedFor(s.root, s.config(), loadJob(s.root, conflicted), 'conflicts'), SECURITY_CHANGES);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, conflicted)), 'human');
      // A later round whose security review passed clears it.
      assert.equal(latestSecurityVerdict({ verdicts: { 1: { security: 'CHANGES' }, 3: { security: 'PASS' } } } as any), 'PASS');
      assert.equal(latestSecurityVerdict({ verdicts: {} } as any), null);
    } finally {
      s.cleanup();
    }
  });

  test('a foreman rework on pr-feedback needs a queued gate for the current head', async () => {
    const s = scratch();
    try {
      const head = 'a'.repeat(40);
      const pr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headOid: head, checks: { state: 'failing', passing: 0, failing: 1, pending: 0 } };
      const id = s.job('Feedback', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', fields: { pr } });
      const refused = (label: string) => s.refusedDecision(id, OFFICE_SCOPE, 'rework', 'fix the failing test', /no queued pr-feedback gate request for .*current PR head/, label);
      refused('no gate request at all');
      enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: 'b'.repeat(40), reserved: null }, from: 'forge' });
      refused('a gate for an older head');
      const done = enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: head, reserved: null }, from: 'forge' });
      ackRequest(s.root, done.id, { status: 'done', result: 'no action: addressed' });
      refused('a gate for this head that was already handled');
      enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: head, reserved: null }, from: 'forge' });
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'rework', '--actor', 'foreman', '--note', 'fix the failing test');
      assert.equal(ok.code, 0, ok.out);
      assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'human').map((e) => [e.action, e.actor]), [['rework', { login: null, source: 'foreman' }]]);
    } finally {
      s.cleanup();
    }
  });

  test('a malformed security review refuses a foreman approval', async () => {
    const s = scratch();
    try {
      const id = s.job('Malformed', { stage: 'build', state: 'running', fields: { verdicts: { 1: { code: 'PASS', security: 'MALFORMED' } } } });
      assert.equal((await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 2 exceeds maxRounds 1')).code, 0);
      assert.equal(s.gates(id)[0].args.reserved, null);
      const before = s.snapshot(id);
      const r = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'cosmetic');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /security review: not PASS/);
      assert.equal(s.snapshot(id), before);
      const at = (verdicts: unknown, action = 'approve') => reservedFor(s.root, s.config(), { id, reason: 'x', verdicts } as any, 'escalation', [], { action });
      assert.equal(at({ 1: { security: 'PASS' } }), null);
      assert.equal(at({ 1: { security: 'CHANGES' } }), SECURITY_CHANGES);
      for (const v of ['MALFORMED', 'MISSING', 'weird']) assert.equal(at({ 1: { security: v } }), SECURITY_UNCLEAR, v);
      for (const a of ['rework', 'revise-spec']) assert.equal(at({ 1: { security: 'CHANGES' } }, a), null, a);
    } finally {
      s.cleanup();
    }
  });

  test('foreman is refused past the total-round ceiling', async () => {
    const s = scratch();
    try {
      // maxRounds 2: the ceiling is 4, and round 5 is past it.
      const id = s.job('Ceiling', { stage: 'build', state: 'running', fields: { round: 5, maxRounds: 2 } });
      const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 5 exceeds the total-round ceiling 4: only a human clears it');
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(s.gates(id), [], 'no foreman gate is queued past the ceiling');
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'human');
      assert.equal(reservedFor(s.root, s.config(), loadJob(s.root, id), 'rounds-exhausted', [], { action: 'rework' }), TOTAL_CEILING);
      for (const action of ['approve', 'rework', 'revise-spec']) s.refusedDecision(id, OFFICE_SCOPE, action, 'one more try', /--actor foreman refused: .*total-round ceiling/, action);
      // A person may still open one more round.
      const person = await s.cli(undefined, 'job', 'human', id, 'rework', '--note', 'try the other approach');
      assert.equal(person.code, 0, person.out);
    } finally {
      s.cleanup();
    }
  });

  test('foreman still decides rounds-exhausted within the ceiling', async () => {
    const s = scratch();
    try {
      const id = s.job('Within', { stage: 'build', state: 'running', fields: { round: 3, maxRounds: 2 } });
      const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 3 exceeds maxRounds 2');
      assert.equal(r.code, 0, r.out);
      assert.equal(s.gates(id).length, 1);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'foreman');
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'cosmetic findings only');
      assert.equal(ok.code, 0, ok.out);
    } finally {
      s.cleanup();
    }
  });

  test('office scope cannot drive, claim or merge', async () => {
    const s = scratch();
    try {
      // Through the CLI once; the other drive commands are in 'office scope refusals, in-process' below.
      const id = s.job('Drive', { stage: 'build', state: 'running' });
      const before = s.snapshot(id);
      const r = await s.cli(OFFICE_SCOPE, 'worktree', 'create', id);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /the office session decides gates and does not drive jobs/);
      assert.equal(s.snapshot(id), before);
    } finally {
      s.cleanup();
    }
  });
});

// Sets FORGE_DAEMON and FORGE_DAEMON_SCOPE on process.env for each call, so it runs on its own,
// outside the concurrent block: the guards below read process.env themselves.
test('office scope refusals, in-process', async () => {
  const s = scratch();
  try {
    const office = { env: { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: OFFICE_SCOPE } };
    const refused = async (args: string[], why: RegExp, env = office) => {
      const r = await forgeInProcess(s.root, args, env);
      assert.equal(r.status, 1, `${args.join(' ')}: ${JSON.stringify(r)}`);
      assert.match(String(r.error?.message), why, args.join(' '));
    };
    const id = s.job('Drive', { stage: 'build', state: 'running' });
    const before = s.snapshot(id);
    const drive = /the office session decides gates and does not drive jobs/;
    for (const args of [
      ['worktree', 'create', id],
      ['job', 'agent', id, 'start', '--role', 'builder'],
      ['job', 'advance', id, '--session', 'office'],
      ['job', 'claim', id, '--session', 'office'],
      ['pr', 'merge', id],
    ])
      await refused(args, drive);
    // Outside the allowlist, job subcommands are refused in the office.
    for (const args of [['release', id], ['round', id], ['link', id, '--none'], ['effort', id, 'low'], ['verdicts', id], ['decision', id], ['paths', id]]) await refused(['job', ...args], drive);
    assert.equal(s.snapshot(id), before);
    // Gate requests come only from the CLI's park and sync paths, in or outside the office.
    for (const env of [{ env: { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined } }, office]) await refused(['requests', 'add', 'gate', '--job', id], /gate requests are written only by/, env);
    assert.deepEqual(s.gates(), []);
    // The office records decisions only as the foreman.
    const spec = s.job('Spec', WAIT_SPEC);
    const specBefore = s.snapshot(spec);
    await refused(['job', 'human', spec, 'approve-spec', '--actor', 'human', '--note', 'ok'], /only with --actor foreman/);
    assert.equal(s.snapshot(spec), specBefore);
    assert.equal(process.env.FORGE_DAEMON, undefined, 'the env is restored');
  } finally {
    s.cleanup();
  }
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
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"state":"CHANGES_REQUESTED","body":"please fix","author":{"login":"alice"},"authorAssociation":"%s","submittedAt":"2026-10-15T00:00:00Z","url":"u"}]},"reviewThreads":{"nodes":[{"isResolved":false,"isOutdated":false,"path":"a.ts","line":1,"comments":{"nodes":[{"author":{"login":"bob"},"authorAssociation":"%s","body":"nit","createdAt":"t","url":"u"}]}}]}}}}}' "\${FAKE_ASSOC:-OWNER}" "\${FAKE_ASSOC:-OWNER}" ;;
esac
`,
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, FAKE_HEAD_OID: process.env.FAKE_HEAD_OID, FAKE_ASSOC: process.env.FAKE_ASSOC };
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
    // Feedback only from people without write access never arms the gate, and the gate stays a human's.
    const outsider = s.job('Outsider', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
    process.env.FAKE_ASSOC = 'NONE';
    process.env.FAKE_HEAD_OID = 'd'.repeat(40);
    syncPr(s.root, config, outsider);
    const job = loadJob(s.root, outsider);
    assert.equal(job.pr?.changesRequested, 1, 'the review is still recorded');
    assert.deepEqual(s.gates(outsider), [], "a stranger's review starts nothing unattended");
    assert.equal(gateOwner(s.root, config, job), 'human');
    process.env.FAKE_ASSOC = 'COLLABORATOR';
    process.env.FAKE_HEAD_OID = 'e'.repeat(40);
    syncPr(s.root, config, outsider);
    assert.equal(s.gates(outsider).length, 1, 'a collaborator arms it');
    assert.equal(gateOwner(s.root, config, loadJob(s.root, outsider)), 'foreman');
  } finally {
    process.env.PATH = saved.PATH;
    for (const k of ['FAKE_HEAD_OID', 'FAKE_ASSOC'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(bin, { recursive: true, force: true });
    s.cleanup();
  }
});

test('failing checks start a foreman rework from sync, once per head, with no office gate', { skip: process.platform === 'win32' }, () => {
  const s = scratch((c) => (c.tracker.github = { ...(c.tracker.github ?? {}), repo: 'o/r' }));
  const bin = path.join(s.root, '..', `fakebin-${path.basename(s.root)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"headRefOid":"%s","mergeable":"MERGEABLE","mergeStateStatus":"UNSTABLE","reviewDecision":null,"statusCheckRollup":[{"conclusion":"FAILURE","status":"COMPLETED"},{"conclusion":"","status":"IN_PROGRESS"}],"mergedAt":null,"closedAt":null,"headRefName":"forge/x","baseRefName":"main"}' "$FAKE_HEAD_OID" ;;
  "repo view") echo o/r ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}' ;;
esac
`,
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, FAKE_HEAD_OID: process.env.FAKE_HEAD_OID };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  const parked = { stage: 'pr' as const, state: 'waiting' as const, waitingOn: 'pr-review' as const, fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } };
  const resumes = (id: string) => listRequests(s.root).filter((q) => q.type === 'resume' && q.job === id);
  try {
    const base = s.config();
    const config = { ...base, daemon: { ...base.daemon, enabled: true } };
    const id = s.job('Red CI', parked);
    const head1 = 'a'.repeat(40);
    process.env.FAKE_HEAD_OID = head1;
    syncPr(s.root, config, id);
    let job = loadJob(s.root, id);
    assert.equal(job.stage, 'build');
    assert.equal(job.state, 'running');
    assert.equal(job.reason, 'forge sync: checks failing on PR #7');
    assert.deepEqual(s.gates(id), [], 'failing checks need no office turn');
    assert.equal(resumes(id).length, 1);
    const feedback = fs.readFileSync(path.join(jobDir(s.root, id), 'feedback.md'), 'utf8');
    assert.match(feedback, /CI is failing on PR #7 at a{12}\./);
    assert.match(feedback, /gh pr checks 7/);
    const rework = readEvents(s.root, id).filter((e) => e.type === 'human' && e.action === 'rework');
    assert.equal(rework.length, 1);
    assert.equal(rework[0].ciHead, head1);
    assert.equal(rework[0].actor?.source, 'foreman', "the foreman's decision, not a person's");
    // Back on pr-review with the same red head (the round pushed nothing new): never a second rework.
    setJob(s.root, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' });
    syncPr(s.root, config, id);
    assert.equal(loadJob(s.root, id).stage, 'pr');
    assert.equal(readEvents(s.root, id).filter((e) => e.type === 'human' && e.action === 'rework').length, 1);
    // A new head that is red again, a GitHub "Update branch" included, reworks again.
    process.env.FAKE_HEAD_OID = 'b'.repeat(40);
    syncPr(s.root, config, id);
    assert.equal(loadJob(s.root, id).stage, 'build');
    // Without the daemon nothing runs unattended: the gate is queued as before.
    const manual = s.job('Manual', parked);
    process.env.FAKE_HEAD_OID = 'c'.repeat(40);
    syncPr(s.root, base, manual);
    job = loadJob(s.root, manual);
    assert.equal(job.waitingOn, 'pr-review');
    assert.equal(s.gates(manual).length, 1);
    // A security review asking for changes doesn't hold a rework: fixing things is mitigation.
    const held = s.job('Held', { ...parked, fields: { ...parked.fields, verdicts: { '1': { security: 'CHANGES' } } } });
    process.env.FAKE_HEAD_OID = 'd'.repeat(40);
    syncPr(s.root, config, held);
    assert.equal(loadJob(s.root, held).stage, 'build');
    // A reserved pattern in the reason still does: it goes through the gate.
    const reserved = { ...config, foreman: { ...config.foreman, reserved: ['billing'] } };
    const billing = s.job('Billing', { ...parked, reason: 'billing change' });
    process.env.FAKE_HEAD_OID = 'f'.repeat(40);
    syncPr(s.root, reserved, billing);
    assert.equal(loadJob(s.root, billing).waitingOn, 'pr-review');
    assert.equal(s.gates(billing).length, 1);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_HEAD_OID === undefined) delete process.env.FAKE_HEAD_OID;
    else process.env.FAKE_HEAD_OID = saved.FAKE_HEAD_OID;
    fs.rmSync(bin, { recursive: true, force: true });
    s.cleanup();
  }
});

/**
 * A scratch repo with the daemon and foreman on, and a fake `gh` whose `pr view` prints the file
 * `pr(head, rollup)` wrote, so check names need no shell quoting. Mutates process.env.PATH.
 */
function ciScratch(edit: (c: any) => void = () => {}) {
  const s = scratch((c) => {
    c.tracker.github = { ...(c.tracker.github ?? {}), repo: 'o/r' };
    edit(c);
  });
  const bin = path.join(s.root, '..', `fakebin-${path.basename(s.root)}`);
  const prFile = path.join(bin, 'pr.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "pr view") cat "${prFile}" ;;
  "repo view") echo o/r ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}' ;;
esac
`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  const pr = (head: string, rollup: unknown[]) =>
    fs.writeFileSync(prFile, JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: null, statusCheckRollup: rollup, mergedAt: null, closedAt: null, headRefName: 'forge/x', baseRefName: 'main' }));
  const base = s.config();
  const config = { ...base, daemon: { ...base.daemon, enabled: true } };
  const parked = { stage: 'pr' as const, state: 'waiting' as const, waitingOn: 'pr-review' as const, fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } };
  const capped = (id: string) => readEvents(s.root, id).filter((e) => e.type === 'ci-rework-capped');
  const ciReworks = (id: string) => readEvents(s.root, id).filter((e) => e.type === 'human' && e.action === 'rework' && e.ciHead);
  const sync = (id: string, head: string, rollup: unknown[] = RED) => {
    pr(head, rollup);
    syncPr(s.root, config, id);
    return loadJob(s.root, id);
  };
  const backToReview = (id: string) => setJob(s.root, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' });
  const cleanup = () => {
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
    s.cleanup();
  };
  return { ...s, config, parked, capped, ciReworks, sync, backToReview, cleanup };
}

const RED = [
  { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' },
  { name: 'unit tests', conclusion: 'FAILURE', status: 'COMPLETED' },
  { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
];
const sha = (c: string) => c.repeat(40);

test('CI rework cap parks the next red head for a human', { skip: process.platform === 'win32' }, async () => {
  const s = ciScratch((c) => (c.pr.maxCiReworks = 2));
  try {
    const id = s.job('Red CI', s.parked);
    assert.equal(s.sync(id, sha('a')).stage, 'build', 'the first CI rework starts');
    s.backToReview(id);
    assert.equal(s.sync(id, sha('b')).stage, 'build', 'the second CI rework starts');
    s.backToReview(id);
    const resumes = listRequests(s.root).filter((q) => q.type === 'resume' && q.job === id).length;
    const job = s.sync(id, sha('c'));
    assert.deepEqual([job.stage, job.state, job.waitingOn], ['pr', 'waiting', 'pr-review']);
    assert.equal(job.reason, 'CI rework cap: 2 CI reworks in a row, checks still failing on PR #7: lint, unit tests. A human decides');
    assert.equal(s.ciReworks(id).length, 2, 'no third rework');
    const ev = s.capped(id);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].head, ev[0].count, ev[0].max, ev[0].checks], [sha('c'), 2, 2, ['lint', 'unit tests']]);
    assert.deepEqual(s.gates(id), [], 'no pr-feedback gate for the capped head');
    assert.equal(gateOwner(s.root, s.config, job), 'human');
    assert.equal(listRequests(s.root).filter((q) => q.type === 'resume' && q.job === id).length, resumes, 'no resume queued');
    s.sync(id, sha('c'));
    assert.equal(s.capped(id).length, 1, 'logged once per head');
    assert.deepEqual(s.gates(id), []);
    const before = s.snapshot(id);
    const refused = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'rework', '--actor', 'foreman', '--note', 'fix the checks');
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /no queued pr-feedback gate request/);
    assert.equal(s.snapshot(id), before);
  } finally {
    s.cleanup();
  }
});

test("a person's action resets the CI rework count", { skip: process.platform === 'win32' }, () => {
  const s = ciScratch((c) => (c.pr.maxCiReworks = 1));
  try {
    const id = s.job('Reset', s.parked);
    assert.equal(s.sync(id, sha('a')).stage, 'build');
    s.backToReview(id);
    assert.match(String(s.sync(id, sha('b')).reason), /^CI rework cap: 1 CI reworks in a row/);
    // A foreman decision is no reset; a person's event of any action is.
    logEvent(s.root, id, 'human', { action: 'approve', note: 'office', actor: { login: null, source: 'foreman' } });
    assert.equal(s.sync(id, sha('c')).stage, 'pr', "the foreman's own event keeps the count");
    logEvent(s.root, id, 'human', { action: 'approve', note: 'looked at it', actor: { login: 'alice', source: 'cli' } });
    // The cap's reason names CI, which the default foreman.reserved lists: it must not hold the rework.
    assert.ok(s.config.foreman.reserved.includes('CI'));
    const job = s.sync(id, sha('d'));
    assert.equal(job.stage, 'build', 'the next red head reworks again');
    assert.equal(s.ciReworks(id).at(-1)?.ciHead, sha('d'));
  } finally {
    s.cleanup();
  }
});

test('maxCiReworks 0 leaves every red head to a human', { skip: process.platform === 'win32' }, () => {
  const s = ciScratch((c) => (c.pr.maxCiReworks = 0));
  try {
    const id = s.job('Never', s.parked);
    const job = s.sync(id, sha('a'));
    assert.deepEqual([job.stage, job.waitingOn], ['pr', 'pr-review']);
    assert.equal(job.reason, 'CI rework cap: 0 CI reworks in a row, checks still failing on PR #7: lint, unit tests. A human decides');
    assert.equal(s.ciReworks(id).length, 0);
    assert.deepEqual(s.gates(id), []);
  } finally {
    s.cleanup();
  }
});

test('CI rework cap drops unsafe check names', { skip: process.platform === 'win32' }, () => {
  const s = ciScratch((c) => (c.pr.maxCiReworks = 0));
  try {
    const bad = ['a`b', '$(id)', 'x\ny', 'q"uote', "it's"];
    const long = 'z'.repeat(10_000);
    const rollup = [
      { name: 'lint', conclusion: 'FAILURE' },
      ...bad.map((name) => ({ name, conclusion: 'FAILURE' })),
      ...['ok-1', 'ok 2', 'ok/3', 'ok.4', 'ok_5'].map((name) => ({ name, conclusion: 'FAILURE' })),
      { context: '  ci/status  ', state: 'ERROR' },
      { name: long, conclusion: 'TIMED_OUT' },
      { name: 'passing', conclusion: 'SUCCESS' },
    ];
    const started = Date.now();
    assert.deepEqual(failingCheckNames(rollup), { names: ['lint', 'ok-1', 'ok 2', 'ok/3', 'ok.4'], more: 8 });
    assert.ok(Date.now() - started < 200, 'a 10k-character name is checked in linear time');
    assert.deepEqual(failingCheckNames([{ name: '`', conclusion: 'FAILURE' }]), { names: [], more: 1 });
    assert.equal(checksText({ names: [], more: 3 }), '3 checks');
    assert.equal(checksText({ names: ['context fallback'], more: 0 }), 'context fallback');
    assert.deepEqual(failingCheckNames([{ context: ' ci/status ', state: 'ERROR' }]).names, ['ci/status'], 'context when there is no name');
    const id = s.job('Hostile', s.parked);
    const job = s.sync(id, sha('a'), rollup);
    assert.equal(job.reason, 'CI rework cap: 0 CI reworks in a row, checks still failing on PR #7: lint, ok-1, ok 2, ok/3, ok.4 and 8 more. A human decides');
    const tell = String((step(loadStepInput(s.root, s.config, id)) as any).tell);
    assert.match(tell, /CI rework cap: 0 CI reworks in a row/);
    const event = JSON.stringify(s.capped(id));
    for (const text of [String(job.reason), event, tell]) {
      for (const b of [...bad, long]) assert.ok(!text.includes(b), `${JSON.stringify(b.slice(0, 20))} leaked into ${text.slice(0, 80)}`);
    }
    assert.ok(!/[`$"'\n]/.test(String(job.reason)), 'no quote, backtick, dollar or newline in the reason');
  } finally {
    s.cleanup();
  }
});

test('repo-proposal is a derived gate class the foreman decides only when allowed', async () => {
  const parked = { state: 'waiting', waitingOn: 'human', reason: 'repo proposal: lib', repos: [] } as any;
  const proposed = [{ v: 2, ts: 't1', type: 'repo-proposed', repo: 'lib', reason: 'core API' }];
  assert.equal(gateClass(parked, proposed), 'repo-proposal');
  assert.equal(gateClass(parked, []), null, 'no pending proposal: a plain human wait');
  assert.equal(gateClass(parked, [...proposed, { v: 2, ts: 't2', type: 'human', action: 'reject-repos', repos: ['lib'] }]), null, 'decided');
  assert.equal(gateClass({ ...parked, reason: 'protected paths: x' }, proposed), null, 'another human wait');
  assert.equal(gateClass({ ...parked, waitingOn: 'spec-approval' }, proposed), 'spec-approval');

  const withRepos = (c: any) => {
    c.repos = [{ name: 'lib', remote: 'https://example.com/lib.git', defaultBranch: 'main' }];
    c.components = [
      { name: 'core', repo: 'lib', path: '.', kind: 'library' },
      { name: 'app', path: '.', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }] },
    ];
  };
  // The default decides leaves the park with a human: no gate request.
  const off = scratch(withRepos);
  try {
    const id = off.job('Default', { stage: 'spec', state: 'running' });
    logEvent(off.root, id, 'repo-proposed', { repo: 'lib', reason: 'core API' });
    const r = await off.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(off.gates(id), []);
    assert.equal(gateOwner(off.root, off.config(), loadJob(off.root, id)), 'human');
  } finally {
    off.cleanup();
  }

  const s = scratch((c) => {
    withRepos(c);
    c.foreman.decides = ['repo-proposal'];
  });
  try {
    const id = s.job('Allowed', { stage: 'spec', state: 'running' });
    logEvent(s.root, id, 'repo-proposed', { repo: 'lib', reason: 'core API' });
    const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib');
    assert.equal(r.code, 0, r.out);
    const g = s.gates(id);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].args, { gate: 'repo-proposal', reserved: null });
    assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'foreman');
    // A reserved pattern in an agent-written proposal reason keeps the gate with a human.
    const cfg = { ...s.config(), foreman: { ...s.config().foreman, reserved: ['database migration'] } };
    assert.equal(reservedFor(s.root, cfg, loadJob(s.root, id), 'repo-proposal'), null);
    const other = s.job('Reserved reason', { stage: 'spec', state: 'running' });
    logEvent(s.root, other, 'repo-proposed', { repo: 'lib', reason: 'core needs a Database Migration first' });
    assert.equal(reservedFor(s.root, cfg, { ...loadJob(s.root, other), reason: 'repo proposal: lib' }, 'repo-proposal'), 'database migration');
    const a = await s.cli(OFFICE_SCOPE, 'job', 'assist', id, '--gate', 'repo-proposal');
    assert.equal(a.code, 0, a.out);
    assert.equal(a.json().stale, false);
    assert.ok(a.json().brief.includes(path.join(jobDir(s.root, id), 'repo-proposals.md')));
    assert.match(a.json().brief, /^Project repos \(JSON\): \[\{"repo":"lib","onJob":false,"components":\["core"\],"usedBy":\[\{"component":"app","repo":null,"type":"build"\}\]\}\]$/m);
    assert.deepEqual(a.json().repos, ['lib'], 'the pending set from events, for --repo');
    assert.match(a.json().brief, /^Pending repos \(JSON\): \[\{"repo":"lib","reason":"core API"\}\]$/m);
    // Only this gate's actions.
    const wrong = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'x');
    assert.equal(wrong.code, 1, wrong.out);
    assert.match(wrong.out, /approve is not a repo-proposal action \(approve-repos, reject-repos\)/);
    const unnamed = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'reject-repos', '--actor', 'foreman', '--note', 'not needed');
    assert.equal(unnamed.code, 1, unnamed.out);
    assert.match(unnamed.out, /needs --repo/);
    // A repo proposed after the assistant was briefed: the foreman's list is no longer the pending set.
    logEvent(s.root, id, 'repo-proposed', { repo: 'tools', reason: 'cli flag' });
    const partial = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'reject-repos', '--repo', 'lib', '--actor', 'foreman', '--note', 'not needed');
    assert.equal(partial.code, 1, partial.out);
    assert.match(partial.out, /also has tools pending, which this decision did not list/);
    assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'human'), []);
    const rejected = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'reject-repos', '--repo', 'lib,tools', '--actor', 'foreman', '--note', 'not needed');
    assert.equal(rejected.code, 0, rejected.out);
    assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'human').map((e) => [e.action, e.repos, e.actor]), [['reject-repos', ['lib', 'tools'], { login: null, source: 'foreman' }]]);
    const resumed = await s.cli(OFFICE_SCOPE, 'job', 'set', id, '--state', 'running');
    assert.equal(resumed.code, 0, resumed.out);
    assert.equal(loadJob(s.root, id).state, 'running');
  } finally {
    s.cleanup();
  }
});

test('a repo hidden from repo-proposals.md is still named in the assistant brief, and the foreman must decide it', async () => {
  const s = scratch((c) => {
    c.repos = ['lib', 'tools'].map((name) => ({ name, remote: `https://example.com/${name}.git`, defaultBranch: 'main' }));
    c.foreman.decides = ['repo-proposal'];
  });
  try {
    const id = s.job('Hidden', { stage: 'spec', state: 'running' });
    logEvent(s.root, id, 'repo-proposed', { repo: 'lib', reason: 'core API' });
    logEvent(s.root, id, 'repo-proposed', { repo: 'tools', reason: 'cli flag' });
    const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib, tools');
    assert.equal(r.code, 0, r.out);
    // The job session rewrites its editable copy to show only lib.
    fs.writeFileSync(path.join(jobDir(s.root, id), 'repo-proposals.md'), '# Repo proposals\n\n## lib (pending)\n\ncore API, nothing else needed\n');
    const a = await s.cli(OFFICE_SCOPE, 'job', 'assist', id, '--gate', 'repo-proposal');
    assert.equal(a.code, 0, a.out);
    assert.match(a.json().brief, /^Pending repos \(JSON\): \[\{"repo":"lib","reason":"core API"\},\{"repo":"tools","reason":"cli flag"\}\]$/m, 'both, from events');
    assert.deepEqual(a.json().repos, ['lib', 'tools']);
    // A foreman that follows the edited file instead of the brief is refused, and nothing is decided.
    const partial = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve-repos', '--repo', 'lib', '--actor', 'foreman', '--note', 'core API');
    assert.equal(partial.code, 1, partial.out);
    assert.match(partial.out, /also has tools pending, which this decision did not list/);
    assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'human'), []);
    assert.deepEqual((loadJob(s.root, id).repos ?? []).map((m: any) => m.repo).filter(Boolean), [], 'no member repo added');
  } finally {
    s.cleanup();
  }
});

// The assistant reads gate files written from untrusted text, so having no Bash is a security property
// no public function exposes (docs/TESTING.md exception): the frontmatter is the only place it lives.
test('assistant agent has no Bash', () => {
  const front = fs.readFileSync(path.join(ROOT, 'agents', 'assistant.md'), 'utf8').split('---')[1];
  assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m, 'no Bash: injected text reaches the CLI only through the one-line verdict');
});
