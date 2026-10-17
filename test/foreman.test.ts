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
import { INVALID_RESERVED, SECURITY_CHANGES, SECURITY_UNCLEAR, gateOwner, latestSecurityVerdict, reservedFor, reservedMatch } from '../lib/foreman.ts';
import { createJob, jobDir, loadJob, logEvent, readEvents, setJob } from '../lib/jobs.ts';
import { syncPr, trustedFeedback } from '../lib/pr.ts';
import { OFFICE_SCOPE, ackRequest, enqueue, listRequests, requestScope } from '../lib/requests.ts';
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

test('config v4 migrates to v7 with foreman defaults off', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 11);
  const v4 = { schemaVersion: 4, git: { base: 'trunk' }, runtime: { models: { builder: 'sonnet' } } };
  const { config, from } = migrateConfig(structuredClone(v4));
  assert.equal(from, 4);
  assert.deepEqual(config, { ...v4, schemaVersion: 11, repos: [] }, 'only schemaVersion and the empty repos list change');
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

  test('office job set carries out only a recorded foreman decision', async () => {
    const s = scratch();
    try {
      const refused = async (id: string, args: string[], why: RegExp, label: string) => {
        const before = s.snapshot(id);
        const r = await s.cli(OFFICE_SCOPE, 'job', ...args);
        assert.equal(r.code, 1, `${label}: ${r.out}`);
        assert.match(r.out, why, label);
        assert.equal(s.snapshot(id), before, `${label}: nothing written`);
      };
      const id = s.job('Set', WAIT_SPEC);
      await refused(id, ['set', id, '--state', 'running'], /no foreman decision recorded/, 'no decision');
      logEvent(s.root, id, 'human', { action: 'approve-spec', note: 'a person', actor: 'human' });
      await refused(id, ['set', id, '--state', 'running'], /no foreman decision recorded/, "a human's decision is not the foreman's");
      assert.equal((await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve-spec', '--actor', 'foreman', '--note', 'ok')).code, 0);
      await refused(id, ['set', id, '--stage', 'build', '--state', 'running'], /approve-spec moves the job to/, 'a stage outside the table');
      await refused(id, ['set', id, '--state', 'running', '--field', 'complexity=low'], /no --field/, '--field');
      await refused(id, ['set', id, '--state', 'running', '--reason', 'x'], /no --waiting-on or --reason/, '--reason');
      await refused(id, ['set', id, '--state', 'done'], /only --state running/, 'another state');
      const ok = await s.cli(OFFICE_SCOPE, 'job', 'set', id, '--state', 'running');
      assert.equal(ok.code, 0, ok.out);
      await refused(id, ['set', id, '--stage', 'build', '--state', 'running'], /is not waiting on a gate/, 'once carried out, nothing more');
      // A decision from before the current park doesn't count.
      const old = s.job('Old', { stage: 'build', state: 'running' });
      logEvent(s.root, old, 'human', { action: 'rework', note: 'x', actor: 'foreman' });
      await new Promise((r) => setTimeout(r, 5));
      setJob(s.root, old, { state: 'waiting', waitingOn: 'escalation', reason: 'again' });
      await refused(old, ['set', old, '--stage', 'build', '--state', 'running'], /no foreman decision recorded/, 'a decision older than the park');
      // Outside the allowlist, job subcommands are refused in the office.
      for (const args of [['release', id], ['round', id], ['link', id, '--none'], ['effort', id, 'low'], ['verdicts', id], ['decision', id], ['paths', id]])
        await refused(id, args, /the office session decides gates and does not drive jobs/, args[0]);
    } finally {
      s.cleanup();
    }
  });

  test('a security review asking for changes keeps every gate with a human', async () => {
    const s = scratch();
    try {
      const id = s.job('Sec', { stage: 'build', state: 'running', fields: { verdicts: { 1: { code: 'PASS', security: 'CHANGES' }, 2: { code: 'CHANGES' } } } });
      const r = await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 3 exceeds maxRounds 2');
      assert.equal(r.code, 0, r.out);
      assert.equal(s.gates(id)[0].args.reserved, SECURITY_CHANGES);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'human');
      const before = s.snapshot(id);
      const refused = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'cosmetic');
      assert.equal(refused.code, 1, refused.out);
      assert.match(refused.out, /security review: CHANGES/);
      assert.equal(s.snapshot(id), before);
      assert.equal((await s.cli(undefined, 'job', 'assist', id, '--gate', 'rounds-exhausted')).json().reserved, SECURITY_CHANGES);
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
      const rework = () => s.cli(OFFICE_SCOPE, 'job', 'human', id, 'rework', '--actor', 'foreman', '--note', 'fix the failing test');
      const refused = async (label: string) => {
        const before = s.snapshot(id);
        const r = await rework();
        assert.equal(r.code, 1, `${label}: ${r.out}`);
        assert.match(r.out, /no queued pr-feedback gate request for .*current PR head/, label);
        assert.equal(s.snapshot(id), before, `${label}: nothing written`);
      };
      await refused('no gate request at all');
      enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: 'b'.repeat(40), reserved: null }, from: 'forge' });
      await refused('a gate for an older head');
      const done = enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: head, reserved: null }, from: 'forge' });
      ackRequest(s.root, done.id, { status: 'done', result: 'no action: addressed' });
      await refused('a gate for this head that was already handled');
      enqueue(s.root, null, { type: 'gate', job: id, args: { gate: 'pr-feedback', key: head, reserved: null }, from: 'forge' });
      const ok = await rework();
      assert.equal(ok.code, 0, ok.out);
      assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'human').map((e) => [e.action, e.actor]), [['rework', { login: null, source: 'foreman' }]]);
    } finally {
      s.cleanup();
    }
  });

  test('a malformed security review keeps the gate with a human', async () => {
    const s = scratch();
    try {
      const id = s.job('Malformed', { stage: 'build', state: 'running', fields: { verdicts: { 1: { code: 'PASS', security: 'MALFORMED' } } } });
      assert.equal((await s.cli(undefined, 'job', 'set', id, '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 2 exceeds maxRounds 1')).code, 0);
      assert.equal(s.gates(id)[0].args.reserved, SECURITY_UNCLEAR);
      assert.equal(gateOwner(s.root, s.config(), loadJob(s.root, id)), 'human');
      const before = s.snapshot(id);
      const r = await s.cli(OFFICE_SCOPE, 'job', 'human', id, 'approve', '--actor', 'foreman', '--note', 'cosmetic');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /security review: not PASS/);
      assert.equal(s.snapshot(id), before);
      const at = (verdicts: unknown) => reservedFor(s.root, s.config(), { id, reason: 'x', verdicts } as any, 'escalation');
      assert.equal(at({ 1: { security: 'PASS' } }), null);
      assert.equal(at({ 1: { security: 'CHANGES' } }), SECURITY_CHANGES);
      for (const v of ['MALFORMED', 'MISSING', 'weird']) assert.equal(at({ 1: { security: v } }), SECURITY_UNCLEAR, v);
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

test('assistant prompt has every gate section and the contract', () => {
  const text = fs.readFileSync(path.join(ROOT, 'agents', 'assistant.md'), 'utf8');
  const front = text.split('---')[1];
  assert.match(front, /^name: assistant$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m, 'no Bash: injected text reaches the CLI only through the one-line verdict');
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
