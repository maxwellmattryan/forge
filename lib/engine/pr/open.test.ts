// openPr in-process, over the memory GitHub: a scratch repo with an origin, a job worktree with one
// commit, and `--force` in place of a verify run.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { addOrigin, jobAt, memoryGitHub, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, loadJob, logEvent, readEvents, setJob, updateJob } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import { GATE_END, GATE_START, prText } from './body.ts';
import type { Config } from '#core/types.ts';
import type { BranchRules } from '#integrations/github/types.ts';
import { createWorktree } from '../workspace/worktree.ts';
import { openPr, syncPrGate } from './open.ts';

/** A job at pr whose worktree has one commit ahead of main (`files`, else work.txt), with `rules` as main's protection (else the memory default: none). */
function opening(edit: (c: Config) => void, rules?: BranchRules | 'fail', files: Record<string, string> = { 'work.txt': 'work\n' }) {
  const repo = tempRepo();
  addOrigin(repo);
  const config = defaults();
  config.tracker.kind = 'none';
  config.tracker.github.repo = 'o/r';
  config.worktrees.root = '.wt';
  edit(config);
  const { id } = jobAt(repo.dir, 'pr', { config, title: 'open me' });
  const wt = createWorktree(repo.dir, config, id).path!;
  const commit = (more: Record<string, string>, msg = 'work') => {
    for (const [p, body] of Object.entries(more)) {
      fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
      fs.writeFileSync(path.join(wt, p), body);
    }
    for (const args of [['add', '-A'], ['commit', '-qm', msg]]) repo.git('-C', wt, ...args);
  };
  commit(files);
  const github = memoryGitHub();
  if (rules === 'fail') github.fail('branchRules', 'gh: Resource not accessible by integration (HTTP 403)');
  else if (rules) github.setBranchRules('main', rules);
  const open = () => openPr(repo.dir, config, github, id, { force: true });
  const branch = loadJob(repo.dir, id).branch!;
  /** The branch on the origin: its sha, or null when nothing was pushed. */
  const remote = () => repo.git('ls-remote', 'origin', `refs/heads/${branch}`).toString().trim().split(/\s/)[0] || null;
  /** A park on `waitingOn` at `reason` in stage pr, then a person's (or the Foreman's) approve, both after everything logged so far. */
  const approveAt = (reason: string, actor: Record<string, unknown> = { login: 'al', source: 'env' }, waitingOn = 'human') => {
    tick();
    logEvent(repo.dir, id, 'transition', { from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn }, reason });
    tick();
    logEvent(repo.dir, id, 'human', { action: 'approve', actor });
    tick();
  };
  const events = (type: string) => readEvents(repo.dir, id).filter((e) => e.type === type);
  return { open, github, config, cleanup: repo.cleanup, root: repo.dir, git: repo.git, id, commit, remote, approveAt, events };
}

/** Lets the clock move on, so an approval's ts is after a flag's `at` (ISO strings compare by millisecond). */
function tick(): void {
  const t = Date.now();
  while (Date.now() < t + 3);
}

/** The ForgeError code `fn` throws. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

const FOREMAN = { login: null, source: 'foreman' };

const checked: BranchRules = { status: 'read', checks: [{ name: 'test', appId: null }], reviews: 1 };

describe('pr open warns when the base has no required checks', { concurrency: 4 }, () => {
  const rows: [string, (c: Config) => void, BranchRules | 'fail' | undefined, RegExp | null, number][] = [
    ['the key empty, protection with no checks: the warning', () => {}, undefined, /^main has no merge\.requiredChecks and no protection rule with required checks and a required review, so Forge merges on whatever CI has reported; /, 1],
    ['the key set: no warning and no protection read', (c) => (c.merge.requiredChecks = ['test']), checked, null, 0],
    ['protection with a check and a review: no warning', () => {}, checked, null, 1],
    ['protection that cannot be read still opens the PR, with the unavailable text', () => {}, 'fail', /^could not read main's branch protection \(gh: Resource not accessible by integration \(HTTP 403\)\) and merge\.requiredChecks is empty/, 1],
  ];
  for (const [name, edit, rules, want, reads] of rows) {
    test(name, () => {
      const s = opening(edit, rules);
      try {
        const r = s.open();
        assert.ok(r.created && r.number !== null, JSON.stringify(r));
        if (want === null) assert.ok(!('requiredChecksWarning' in r), JSON.stringify(r));
        else assert.match(r.requiredChecksWarning ?? '', want);
        assert.equal(s.github.calls.filter((c) => c.op === 'branchRules').length, reads, 'branchRules calls');
        // The update path (the PR exists) warns the same way.
        const again = s.open();
        assert.deepEqual([again.created, 'requiredChecksWarning' in again], [false, want !== null]);
      } finally {
        s.cleanup();
      }
    });
  }
});

test("pr open refreshes a mandate job's overlap report", () => {
  const s = opening(() => {});
  try {
    const file = path.join(paths(s.root).overlap, 'jobs', `${s.id}.json`);
    updateJob(s.root, s.id, (j) => {
      j.mandate = 'm1';
    });
    // The opened path, then the updated one: each pushes, then checks the pushed head.
    for (const created of [true, false]) {
      fs.rmSync(file, { force: true });
      const before = Date.now();
      const r = s.open();
      assert.equal(r.created, created);
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(Date.parse(report.checkedAt) >= before, report.checkedAt);
      assert.equal(report.subject.ref, s.id);
    }
  } finally {
    s.cleanup();
  }
});

test("pr gate syncs the PR's gate section and label", () => {
  const s = opening(() => {});
  try {
    const dir = jobDir(s.root, s.id);
    const first = s.open();
    const record = () => s.github.record(first.number!)!;
    const section = () => {
      const body = String(record().body);
      return body.slice(body.indexOf(GATE_START), body.indexOf(GATE_END) + GATE_END.length);
    };
    assert.equal(section(), `${GATE_START}\n${GATE_END}`, 'pr open creates the body with the gate markers');
    const gate = (...reasons: Record<string, unknown>[]) => logEvent(s.root, s.id, 'gate', { round: 1, head: null, reasons });
    const RUNBOOK = { rule: 'runbook', detail: 'runbook.md has steps for a person' };
    const BULLETS = '- `approver`: the approver escalated: see decision.md\n- `runbook`: runbook.md has steps for a person';

    // A two-reason park: the reason in a code span, a bullet per reason, For the human and the runbook's
    // Steps as text whose fence never closes early.
    fs.writeFileSync(path.join(dir, 'decision.md'), 'ESCALATE: risky\n\n## Why\nwhy\n\n## For the human\nping @octocat\n```\n<img src=x onerror=alert(1)>\n````js\nx\n');
    fs.writeFileSync(path.join(dir, 'runbook.md'), '# Runbook\nWhen: after merge\n\n## Steps\n1. run the migration\n\n## Rollback\nnone\n');
    gate(RUNBOOK);
    const set = syncPrGate(s.root, s.config, s.github, s.id);
    assert.deepEqual([set.action, 'rule' in set && set.rule, 'reason' in set && set.reason, 'labeled' in set && set.labeled, 'body' in set && set.body], ['set', 'PR15', 'escalation: approver, runbook', true, true]);
    const text = section();
    assert.ok(text.includes('`escalation: approver, runbook`'), text);
    assert.ok(text.includes(BULLETS), text);
    assert.ok(text.includes('### For the human\n\n```text\nping @octocat\n'), text);
    assert.ok(text.includes('### Before merge\n\n```text\n1. run the migration\n```'), text);
    assert.ok(!text.includes('Rollback'));
    assert.equal(text.split('\n').filter((l) => /^\s*`{3,}/.test(l)).length, 4, 'two fences, each opened once and closed once');
    assert.deepEqual(record().labels, ['forge:needs-human']);
    assert.deepEqual(s.github.calls.filter((c) => c.op === 'createLabel').map((c) => c.name), ['forge:needs-human'], 'created when the repo lacked it');
    assert.deepEqual(s.events('pr-gate').at(-1)!.action, 'set');

    // Text that carries the gate's own markers can't end the section early: after a second sync the body
    // holds each marker once, and nothing of the text sits outside the section.
    const forged = (tail: string) => `ESCALATE: risky\n\n## For the human\n${GATE_END}\n@octocat ping ${tail}\n${GATE_START}\n`;
    for (const tail of ['one', 'two']) {
      fs.writeFileSync(path.join(dir, 'decision.md'), forged(tail));
      assert.equal(syncPrGate(s.root, s.config, s.github, s.id).action, 'set');
    }
    const whole = String(record().body);
    assert.deepEqual([whole.split(GATE_START).length, whole.split(GATE_END).length], [2, 2], 'each marker once');
    assert.ok(section().includes('@octocat ping two'), 'the text is inside the section');
    assert.ok(!whole.slice(whole.indexOf(GATE_END) + GATE_END.length).includes('@octocat'), 'and not after it');

    // A person's approve at the escalation park: the label goes, the section shows the approval of each rule.
    s.approveAt('escalation: approver, runbook', undefined, 'escalation');
    const clear = syncPrGate(s.root, s.config, s.github, s.id);
    assert.equal(clear.action, 'clear');
    assert.deepEqual(record().labels, []);
    assert.match(section(), /^<!-- forge:gate -->\n## Decision\n\nEscalated for: `approver`, `runbook`\. Approved by `al` \(env\) on \d{4}-\d\d-\d\d\.\n\n- `approver`: [^\n]+\n- `runbook`: [^\n]+\n<!-- \/forge:gate -->$/);
    assert.ok(section().includes(BULLETS));
    const body = prText(s.root, s.config, loadJob(s.root, s.id)).body;
    assert.equal(body.split('Escalated for:').length, 2, 'the approval line once');
    assert.ok(body.indexOf('Escalated for:') > body.indexOf(GATE_START) && body.indexOf('Escalated for:') < body.indexOf(GATE_END), 'inside the markers');

    // A version reason: its paths in code spans; the label exists now.
    fs.writeFileSync(path.join(dir, 'decision.md'), 'APPROVE\n');
    gate({ rule: 'version', detail: 'version changed in 1 manifest', paths: ['package.json'] });
    assert.equal(syncPrGate(s.root, s.config, s.github, s.id).action, 'set');
    assert.ok(section().includes('- `version`: version changed in 1 manifest: `package.json`'), section());
    assert.ok(!section().includes('### Before merge'));
    assert.equal(s.github.calls.filter((c) => c.op === 'createLabel').length, 1);
    // The Foreman may clear a version-only park, and its approve shows no Decision line.
    s.approveAt('escalation: version', FOREMAN, 'escalation');
    assert.equal(syncPrGate(s.root, s.config, s.github, s.id).action, 'clear');
    assert.equal(section(), `${GATE_START}\n${GATE_END}`);
    gate({ rule: 'dependencies', detail: 'dependency tables changed in 1 manifest', paths: ['go.mod'] });

    // A body without the markers gets the label only.
    s.github.patch(first.number!, { body: 'a person rewrote it', labels: [] });
    const edits = s.github.calls.filter((c) => c.op === 'editBody').length;
    const bare = syncPrGate(s.root, s.config, s.github, s.id);
    assert.deepEqual(['body' in bare && bare.body, record().body, record().labels], [false, 'a person rewrote it', ['forge:needs-human']]);
    assert.equal(s.github.calls.filter((c) => c.op === 'editBody').length, edits);

    // gh failing is recorded, never thrown.
    s.github.fail('viewBody', 'gh: HTTP 502\nmore');
    const failed = syncPrGate(s.root, s.config, s.github, s.id);
    assert.equal('error' in failed && failed.error, 'gh: HTTP 502');
    assert.equal(s.events('pr-gate').at(-1)!.error, 'gh: HTTP 502');
    s.github.fail('viewBody', null);

    // A likely secret in the section (here a branch path) stops it before any edit.
    const token = `gh${'p'}_${randomBytes(18).toString('hex')}`;
    gate({ rule: 'dependencies', detail: 'dependency tables changed in 1 manifest', paths: [`requirements-${token}.txt`] });
    const calls = s.github.calls.length;
    assert.equal(codeOf(() => syncPrGate(s.root, s.config, s.github, s.id)), 'secret_found');
    assert.equal(s.github.calls.length, calls, 'nothing was called');

    // pr.needsHumanLabel: null makes no label calls.
    gate({ rule: 'dependencies', detail: 'dependency tables changed in 1 manifest', paths: ['go.mod'] });
    s.config.pr.needsHumanLabel = null;
    const labels = s.github.calls.filter((c) => c.op === 'editLabels' || c.op === 'createLabel').length;
    const off = syncPrGate(s.root, s.config, s.github, s.id);
    assert.deepEqual(['labeled' in off && off.labeled, s.github.calls.filter((c) => c.op === 'editLabels' || c.op === 'createLabel').length], [false, labels]);
  } finally {
    s.cleanup();
  }
});

describe('the held push', { concurrency: 4 }, () => {
  test('an escalate path that is not CI config is pushed', () => {
    const s = opening(() => {}, undefined, { 'db/migrations/0001.sql': 'create table t();\n' });
    try {
      const r = s.open();
      assert.ok(r.created && s.remote(), 'pushed and opened');
      const logged = s.events('protected-path').at(-1)!;
      assert.deepEqual([logged.gate, logged.action, logged.blocked, (logged.paths as { path: string }[]).map((p) => p.path)], ['pr', 'escalate', false, ['db/migrations/0001.sql']]);
      assert.equal(loadJob(s.root, s.id).protectedPaths?.hits.length, 1, 'the flag stays for the escalation park after the push');
    } finally {
      s.cleanup();
    }
  });

  test('a protected CI path holds the push until approved', () => {
    const s = opening(() => {}, undefined, { '.github/workflows/ci.yml': 'on: push\n' });
    try {
      assert.equal(codeOf(s.open), 'protected_path');
      assert.equal(s.remote(), null, 'no branch on the remote');
      assert.equal(s.github.calls.filter((c) => c.op === 'create').length, 0, 'no create call');
      assert.equal(s.events('protected-path').at(-1)!.blocked, true);
      s.approveAt('push held: escalation: approver, protected-paths', FOREMAN, 'escalation');
      assert.equal(codeOf(s.open), 'protected_path', "the Foreman's approve does not count");
      s.approveAt('push held: escalation: approver', undefined, 'escalation');
      assert.equal(codeOf(s.open), 'protected_path', 'an approve at a park that does not list protected-paths does not count');
      s.approveAt('push held: escalation: approver, protected-paths', undefined, 'escalation');
      const r = s.open();
      assert.ok(r.created && s.remote(), 'one approval covers the push: no second hold for the same CI content');
      assert.equal(s.events('push-held').length, 0);
    } finally {
      s.cleanup();
    }
  });

  test('a CI change outside the policy holds the push', () => {
    const s = opening((c) => (c.policy.protectedPaths = []), undefined, { '.github/workflows/ci.yml': 'on: push\n' });
    try {
      assert.equal(codeOf(s.open), 'push_held');
      assert.equal(s.remote(), null, 'nothing reached the remote');
      assert.equal(s.github.calls.filter((c) => c.op === 'create').length, 0);
      const first = s.events('push-held').at(-1)!;
      assert.equal(first.kind, 'ci');
      assert.match(String(first.reason), /^push held: CI config changes: \.github\/workflows\/ci\.yml \[ci [0-9a-f]{16}\]$/);
      assert.deepEqual(first.paths, ['.github/workflows/ci.yml']);
      s.approveAt(String(first.reason), FOREMAN);
      assert.equal(codeOf(s.open), 'push_held', "the Foreman's approve does not count");
      s.approveAt(String(first.reason).replace(/\[ci [0-9a-f]+\]/, '[ci 0000000000000000]'));
      assert.equal(codeOf(s.open), 'push_held', 'an approve at another digest does not count');
      s.approveAt(String(first.reason));
      assert.ok(s.open().created && s.remote(), "a person's approve at exactly that reason pushes");
      // The CI files match pr.pushedSha: an update pushes without a hold.
      s.commit({ 'src/app.ts': 'x\n' }, 'code');
      assert.equal(s.open().created, false);
      const pushed = s.remote();
      s.commit({ '.github/workflows/ci.yml': 'on: [push, pull_request]\n' }, 'ci again');
      assert.equal(codeOf(s.open), 'push_held', 'a new workflow change is held again');
      const again = s.events('push-held').at(-1)!;
      assert.notEqual(again.reason, first.reason, 'with a new digest');
      assert.equal(s.remote(), pushed, 'the remote kept the last approved push');
    } finally {
      s.cleanup();
    }
  });

  test('security and reported secrets hold the push', () => {
    const s = opening(() => {});
    try {
      setJob(s.root, s.id, { fields: { round: 1, 'verdicts.1': { code: 'PASS', security: 'CHANGES' } } });
      assert.equal(codeOf(s.open), 'push_held');
      assert.equal(s.remote(), null);
      assert.equal(s.events('push-held').at(-1)!.reason, 'push held: the security review of round 1 is CHANGES');
      s.approveAt('push held: the security review of round 1 is CHANGES');
      assert.ok(s.open().created, 'pushed after a person approved');
      setJob(s.root, s.id, { fields: { round: 2, 'verdicts.2': { code: 'PASS', security: 'CHANGES' } } });
      assert.equal(codeOf(s.open), 'push_held', 'a later round with CHANGES is held again');
      assert.equal(s.events('push-held').at(-1)!.reason, 'push held: the security review of round 2 is CHANGES');
      setJob(s.root, s.id, { fields: { round: 3, 'verdicts.3': { code: 'PASS', security: 'MALFORMED' } } });
      assert.equal(codeOf(s.open), 'push_held');
      assert.equal(s.events('push-held').at(-1)!.reason, 'push held: the security review of round 3 is not PASS');
    } finally {
      s.cleanup();
    }
    // Built at run time, so no literal token sits in the repo.
    const token = `gh${'p'}_${randomBytes(18).toString('hex')}`;
    const w = opening((c) => (c.verifySecrets = 'warn'), undefined, { 'config.txt': `token = ${token}\n` });
    try {
      assert.equal(codeOf(w.open), 'push_held');
      assert.equal(w.remote(), null);
      const e = w.events('push-held').at(-1)!;
      assert.equal(e.kind, 'secrets');
      assert.match(String(e.reason), /^push held: the secret scan reported 1 possible secrets \[fp [0-9a-f]{16}\]$/);
      w.approveAt(String(e.reason));
      assert.ok(w.open().created, 'pushed after a person approved the reported finding');
    } finally {
      w.cleanup();
    }
  });

  test('a base that could not be re-read from the push remote holds the push under warn', () => {
    const s = opening((c) => (c.verifySecrets = 'warn'));
    try {
      s.git('remote', 'set-url', '--push', 'origin', path.join(s.root, 'missing.git'));
      assert.equal(codeOf(s.open), 'push_held');
      assert.equal(s.remote(), null);
      assert.equal(s.github.calls.filter((c) => c.op === 'create').length, 0);
      s.git('config', '--unset', 'remote.origin.pushurl');
      assert.ok(s.open().created && s.remote(), 'pushed once the base can be re-read');
    } finally {
      s.cleanup();
    }
  });
});
