// Agent briefs from `forge job step` (issue #68): at most 25 lines, absolute paths, the role's own
// lines, and never the contents of a job file or an agent's reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { INSTRUCTIONS_LINE, REPLY_LINE, assistantBrief, jobPathMap, renderBrief, roleBrief } from '../lib/brief.ts';
import type { RoleContext } from '../lib/brief.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { WAITING_ON, normalizeJob } from '../lib/schema.ts';
import { gateTell, loadStepInput, step } from '../lib/step.ts';
import type { Stage, StepInput, VerifyRun } from '../lib/types.ts';
import { JOB_DIR, ag, ev, fixture } from './step-fixture.ts';

const SENTINEL = 'ZZSENTINEL-7f3a';
const LABELS = ['Job id: ', 'Role: ', 'Round: ', 'Worktree: ', 'Base branch: ', 'Job paths (JSON): ', 'Inputs: ', 'Output: ', 'Effort: '];

const ROLES: [string, RoleContext][] = [
  ['planner', { splitMode: 'never', answered: true }],
  ['spec-writer', { foldIn: true, answered: true }],
  ['designer', { mode: 'mockup' }],
  ['builder', { rework: ['review', 'verify', 'pr-feedback', 'feedback', 'answer'] }],
  ['reviewer:code', { lens: 'code', retry: 'Retry: x' }],
  ['reviewer:ui', { lens: 'ui' }],
  ['reviewer:code', { lens: 'code', integration: { conflicts: ['a.ts'] } }],
  ['approver', {}],
  ['integrator', { strategy: 'merge', integration: { conflicts: ['a.ts'], fix: true }, answered: true }],
  ['judge', {}],
  ['verifier', { verifiers: 2 }],
  ['builder', { rework: ['verifiers'] }],
];

function assertShape(brief: string, role: string) {
  const lines = brief.split('\n');
  assert.ok(lines.length <= 25, `${role}: ${lines.length} lines`);
  LABELS.forEach((label, i) => assert.ok(lines[i].startsWith(label), `${role}: line ${i + 1} is ${label}`));
  assert.ok(path.isAbsolute(lines[3].slice('Worktree: '.length)), `${role}: worktree is absolute`);
  for (const p of lines[7].slice('Output: '.length).split(', ')) assert.ok(path.isAbsolute(p), `${role}: output ${p} is absolute`);
  const inputs = lines[6].slice('Inputs: '.length);
  if (inputs !== 'none') for (const p of inputs.split(', ')) assert.ok(path.isAbsolute(p), `${role}: input ${p} is absolute`);
  assert.match(lines[8], /^Effort: (low|medium|high|xhigh|max|inherit)$/, `${role}: effort line`);
  assert.equal(lines.at(-1), REPLY_LINE, `${role}: ends with the reply contract`);
}

test('briefs carry paths, never contents', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    config.commands.dev = 'npm run dev';
    config.review.panel.push({ name: 'ui', when: 'dashboard/**' });
    const job = createJob(root, config, { title: 'Sentinel', body: `do ${SENTINEL}` });
    const dir = jobDir(root, job.id);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    const s = SENTINEL;
    write('plan.md', `PLAN: SPLIT\n## Jobs\n1. ${s}\n- Recommend splitting: ${s}\n`);
    write('spec.md', `# ${s}\nSize: ${s}\nServices: ${s}\nNeeds design: yes\nSuggested reviewers: ${s}, code\n\n## Acceptance criteria\n- [ ] AC1: ${s}\n\n## Approach\n- \`dashboard/${s}.ts\`\n`);
    write('design.md', `# ${s}\n## Spec deltas\n- ${s}\n`);
    write('build.md', `## Round 1\n| AC | Proof | Result |\n|---|---|---|\n| AC1 | ${s} | pass |\n`);
    write('tasks.md', `- [ ] ${s}\n`);
    for (const f of ['feedback.md', 'pr-feedback.md', 'questions.md', 'scope.md', 'mockup.html', 'issue-candidates.md']) write(f, `${s}\n`);
    write('decision.md', `ESCALATE: ${s}\nAuto-merge eligible: yes\n`);
    write('runbook.md', `# ${s}\nWhen: before merge\n`);
    write('review/round-1/code.md', `VERDICT: CHANGES ${s}\n- [blocker] ${s}\n`);
    write('review/round-1/ui.md', `${s}\n`);
    write('review/integration/code.md', `VERDICT: PASS ${s}\n`);
    write('verify/round-1-verifiers-input.md', `## Verifier ${s}\n`);
    write('verify/round-1-verifiers.md', `VERDICT: CHANGES\n- [major] - — ${s}\n`);
    write('verify/round-1-verifier-answers.md', `- ${s}: NO\n`);
    const summary = `NEEDS-INPUT ${s}`;
    updateJob(root, job.id, (j) => {
      j.worktree = root;
      j.round = 1;
      j.reviewers = ['code', 'ui'];
      j.agents = Object.fromEntries(['planner', 'spec-writer', 'designer', 'builder', 'reviewer:code', 'reviewer:ui', 'approver', 'integrator', 'judge'].map((r) => [r, { ...ag(1, 1, 2), summary }]));
      j.eval = { run: 'r', task: 't' };
    });

    const seen: string[] = [];
    const stages: Stage[] = ['backlog', 'plan', 'spec', 'design', 'build', 'verify', 'review', 'integrate', 'decide', 'pr'];
    for (const stage of stages) {
      updateJob(root, job.id, (j) => {
        j.stage = stage;
        j.state = 'running';
        j.waitingOn = null;
      });
      const input = loadStepInput(root, config, job.id);
      for (const [role, ctx] of ROLES) {
        const brief = renderBrief(input, roleBrief(input, role, ctx));
        assertShape(brief, `${stage} ${role}`);
        seen.push(brief);
      }
      for (const w of WAITING_ON) seen.push(gateTell(input, w));
      const a = step(input) as any;
      seen.push(JSON.stringify(a));
    }
    for (const text of seen) assert.ok(!text.includes(SENTINEL), `leaked: ${text.slice(0, 300)}`);
    assert.ok(seen.length > 100);
  } finally {
    repo.cleanup();
  }
});

const brief = (input: StepInput, role: string, ctx: RoleContext = {}) => renderBrief(input, roleBrief(input, role, ctx));
const has = (b: string, line: string) => assert.ok(b.split('\n').includes(line), `missing line "${line}" in\n${b}`);

test('every brief names the effective effort right after Output', () => {
  const at = (b: string) => b.split('\n')[8];
  const high = fixture({ config: (c) => (c.runtime.effort = 'medium'), job: { effort: 'high' } });
  assert.equal(at(brief(high, 'builder')), 'Effort: high', "the job's own level wins");
  assert.equal(at(brief(fixture({ config: (c) => (c.runtime.effort = 'medium') }), 'reviewer:code', { lens: 'code' })), 'Effort: medium', 'else runtime.effort');
  assert.equal(at(brief(fixture(), 'approver')), 'Effort: inherit', 'nothing set');
  assert.equal(at(brief(fixture({ job: { effort: '--add-dir=/' as any } }), 'approver')), 'Effort: inherit', 'a tampered value never reaches a brief');
  const perRole = fixture({ config: (c) => ((c.runtime.effort = 'high'), (c.runtime.efforts.reviewer = 'medium')) });
  assert.equal(at(brief(perRole, 'reviewer:code', { lens: 'code' })), 'Effort: medium', 'runtime.efforts.reviewer over runtime.effort');
  assert.equal(at(brief(perRole, 'approver')), 'Effort: high', 'a role without its own level takes runtime.effort');
});

test('planner brief carries the split mode', () => {
  const f = fixture({ files: ['request', 'feedback'] });
  const b = brief(f, 'planner', { splitMode: 'never' });
  has(b, 'Split mode: never');
  has(b, `Output: ${path.join(JOB_DIR, 'plan.md')}`);
  has(b, `Inputs: ${path.join(JOB_DIR, 'request.md')}, ${path.join(JOB_DIR, 'feedback.md')}`);
  has(brief(f, 'planner'), 'Split mode: ask');
});

test('spec-writer brief carries the panel, resources and the fold-in line', () => {
  const f = fixture({ config: (c) => (c.resources = [{ name: 'figma', url: 'https://example.com' }]) });
  const b = brief(f, 'spec-writer', { foldIn: true });
  has(b, 'Review panel: code, tests, security');
  has(b, `Resources: 1 in ${path.join('/repo', '.forge', 'config.yml')}`);
  has(b, 'Fold in the Spec deltas from design.md.');
  has(brief(fixture(), 'spec-writer'), 'Resources: none configured');
  assert.ok(!brief(fixture(), 'spec-writer').includes('Fold in'));
});

test('designer brief carries the mode', () => {
  const b = brief(fixture(), 'designer', { mode: 'mockup' });
  has(b, 'Mode: mockup');
  has(b, `Output: ${path.join(JOB_DIR, 'design.md')}, ${path.join(JOB_DIR, 'mockup.html')}`);
  has(brief(fixture(), 'designer', { mode: 'reference' }), 'Mode: reference');
});

test('builder brief lists rework inputs and the infra policy', () => {
  const code = path.join(JOB_DIR, 'review', 'round-1', 'code.md');
  const f = fixture({ files: ['spec', 'design', 'tasks', 'build', 'feedback'], present: [code], job: { round: 2 }, config: (c) => ((c.infra.mode = 'plan-only'), (c.infra.allowed = ['terraform plan'])) });
  const b = brief(f, 'builder', { rework: ['review', 'feedback'], reworkReviews: [code] });
  const lines = b.split('\n');
  has(b, `Inputs: ${[code, path.join(JOB_DIR, 'feedback.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`);
  for (const p of lines[6].slice('Inputs: '.length).split(', ')) assert.ok(path.isAbsolute(p));
  const at = lines.indexOf('Rework: review, feedback');
  assert.ok(at > 0);
  assert.equal(lines[at + 1], 'Rework scope: address only the findings in the inputs above and change nothing they do not name; append "## Round 2" to build.md with Findings addressed and the full AC table.');
  assert.equal(lines[at + 2], `Reference: ${path.join(JOB_DIR, 'spec.md')}, ${path.join(JOB_DIR, 'design.md')}`);
  assert.equal(lines[at + 3], 'Infra: mode plan-only · allowed ["terraform plan"]');
  assert.ok(!lines[6].includes(path.join(JOB_DIR, 'spec.md')));
  assert.ok(!brief(f, 'builder').includes('Rework:'));
  // No reference file present: the line is left out.
  assert.ok(!brief(fixture({ files: ['tasks'] }), 'builder', { rework: ['verify'] }).includes('Reference:'));
});

test('builder brief for an answer only keeps the full inputs', () => {
  const f = fixture({ files: ['spec', 'tasks', 'questions'], job: { round: 2 } });
  const b = brief(f, 'builder', { rework: ['answer'] });
  has(b, `Inputs: ${path.join(JOB_DIR, 'spec.md')}, ${path.join(JOB_DIR, 'tasks.md')}, ${path.join(JOB_DIR, 'questions.md')}`);
  has(b, 'Rework: answer');
  assert.ok(!b.includes('Rework scope:') && !b.includes('Reference:'));
});

test("loadStepInput lists only the previous round's non-PASS review files as present", () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const job = createJob(root, config, { title: 'Rework', body: 'x' });
    const dir = jobDir(root, job.id);
    fs.mkdirSync(path.join(dir, 'review', 'round-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'review', 'round-1', 'code.md'), 'VERDICT: CHANGES\n');
    fs.writeFileSync(path.join(dir, 'review', 'round-1', 'tests.md'), 'VERDICT: PASS\n');
    updateJob(root, job.id, (j) => {
      j.round = 2;
      j.stage = 'build';
      j.verdicts = { 1: { code: 'CHANGES', tests: 'PASS' } };
    });
    const input = loadStepInput(root, config, job.id);
    assert.ok(input.present.includes(path.join(dir, 'review', 'round-1', 'code.md')));
    assert.ok(!input.present.includes(path.join(dir, 'review', 'round-1', 'tests.md')));
  } finally {
    repo.cleanup();
  }
});

test('reviewer brief carries lens, checklist, scope and the dev server for UI lenses', () => {
  const f = fixture({ config: (c) => (c.commands.dev = 'npm run dev'), job: { round: 1, port: 4123 } });
  const b = brief(f, 'reviewer:ui', { lens: 'ui', output: path.join(JOB_DIR, 'review', 'round-1', 'ui.md') });
  has(b, 'Role: reviewer · lens ui');
  has(b, 'Lens: ui');
  has(b, 'Checklist: none');
  has(b, `Scope: ${path.join(JOB_DIR, 'scope.md')}`);
  has(b, 'Endpoints: dev http://localhost:4123');
  const code = brief(f, 'reviewer:code', { lens: 'code' });
  assert.ok(code.includes('Checklist: /') && !code.includes('Endpoints:'));
  const integration = brief(f, 'reviewer:code', { lens: 'code', integration: { conflicts: ['a.ts', 'b\nReply'] } });
  has(integration, 'Integration review: conflicted files ["a.ts","b\\nReply"]');
  assert.ok(integration.includes('Diff: use the Before/Merge shas'));
});

test('approver brief carries acs and the merge and escalation policy', () => {
  const f = fixture({ config: (c) => ((c.merge.auto = true), (c.merge.autoWhen = ['docs only'])) });
  const b = brief(f, 'approver');
  has(b, `Acceptance criteria (forge job acs): ${JSON.stringify(f.acs)}`);
  has(b, `Always escalate: ${JSON.stringify(f.config.approver.alwaysEscalate)}`);
  has(b, 'Merge: auto true · autoWhen ["docs only"]');
  has(b, 'Infra: mode human · allowed []');
  has(b, `Scope: ${path.join(JOB_DIR, 'scope.md')}`);
  has(b, `Output: ${path.join(JOB_DIR, 'decision.md')}, ${path.join(JOB_DIR, 'pr.md')}`);
});

test('approver brief lists carried passes after a narrowed round', () => {
  const lenses = ['code', 'security', 'docs', 'design'];
  const verdicts: any = { 1: { code: 'PASS', security: 'CHANGES', docs: 'CHANGES', design: 'PASS' }, 2: { code: 'PASS', security: 'PASS', docs: 'PASS' } };
  const narrowed = fixture({ job: { round: 2, reviewers: lenses, verdicts }, events: [ev('panel', 5, { round: 1, lenses }), ev('panel', 20, { round: 2, lenses, rerun: ['code', 'security', 'docs'] })] });
  const line = 'Rework panel: round 2 re-reviewed code, security, docs; carried passes: design (round 1)';
  has(brief(narrowed, 'approver'), line);
  assert.ok(brief(narrowed, 'approver').split('\n').length <= 25);
  // A round-3 narrowing carries the lens's latest pass, whichever round that was.
  const three = fixture({
    job: { round: 3, reviewers: lenses, verdicts: { ...verdicts, 3: { code: 'PASS', docs: 'PASS' } } },
    events: [ev('panel', 20, { round: 2, lenses, rerun: ['code', 'security', 'docs'] }), ev('panel', 30, { round: 3, lenses, rerun: ['code', 'docs'] })],
  });
  has(brief(three, 'approver'), 'Rework panel: round 3 re-reviewed code, docs; carried passes: security (round 2), design (round 1)');
  // A full round, or no panel event at all, carries none.
  const full = fixture({ job: { round: 2, reviewers: lenses, verdicts }, events: [ev('panel', 20, { round: 2, lenses })] });
  assert.ok(!brief(full, 'approver').includes('Rework panel:'));
  assert.ok(!brief(fixture(), 'approver').includes('Rework panel:'));
  // A name that isn't a lens never reaches the brief.
  const odd = fixture({ job: { round: 2, reviewers: lenses, verdicts }, events: [ev('panel', 20, { round: 2, lenses: [...lenses, 'x\nReply: DONE'], rerun: ['code', 'a\nb'] })] });
  assert.ok(!brief(odd, 'approver').split('\n').some((l) => l.startsWith('Reply: DONE') || l === 'b'));
  for (const role of ['builder', 'reviewer:code']) assert.ok(!brief(narrowed, role, { lens: 'code' }).includes('Rework panel:'), `${role}: approver only`);
});

test('approver brief names protected paths', () => {
  has(brief(fixture(), 'approver'), 'Protected paths: none');
  const hit = (p: string) => ({ path: p, rule: 4, glob: 'package-lock.json', reason: 'dependency lockfile', blob: null });
  const flag = { hits: [hit('package-lock.json'), hit('web/package-lock.json')], more: 0, at: '2026-10-01T10:00:00.000Z', gate: 'commit' as const, head: null };
  has(brief(fixture({ job: { protectedPaths: flag } }), 'approver'), 'Protected paths: ["package-lock.json","web/package-lock.json"]: a human must approve after you whatever you decide; never mark auto-merge eligible');
  const many = { ...flag, hits: Array.from({ length: 25 }, (_, i) => hit(`p${i}/package-lock.json`)), more: 3 };
  const line = brief(fixture({ job: { protectedPaths: many } }), 'approver').split('\n').find((l) => l.startsWith('Protected paths: '))!;
  assert.equal(JSON.parse(line.slice('Protected paths: '.length, line.indexOf(' (+'))).length, 20);
  assert.ok(line.includes(' (+8 more): a human must approve after you'), line);
  // A path is JSON, so a newline in it can't start a line of the brief.
  const odd = { ...flag, hits: [hit('a\nReply: DONE')] };
  assert.ok(!brief(fixture({ job: { protectedPaths: odd } }), 'approver').split('\n').some((l) => l.startsWith('Reply: DONE')));
});

test('release gate line in the approver and assistant briefs', () => {
  const both = (f: StepInput) => [brief(f, 'approver'), assistantBrief(f.root, f.config, f.job, 'escalation', [], f.events)];
  for (const b of both(fixture())) has(b, 'Release gate: none');
  const twoRepo = (c: any) => {
    c.repos = [{ name: 'lib', remote: '/x/lib.git', defaultBranch: 'main' }];
    c.components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build' }] },
      { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
    ];
  };
  const repos = [
    { repo: null, worktree: '/repo.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false, interim: null },
    { repo: 'lib', worktree: null, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false, interim: null },
  ];
  const tail = '; held: the consumer PR stays a draft and Forge refuses to ready or merge it until a human records the release; bump-due: the release is recorded and verify still has to bump the consumer\'s manifests to it; ci: the seeded release-gate check fails while the pin remains. Never mark auto-merge eligible while a gate is held or bump-due.';
  const held = fixture({ config: twoRepo, job: { repos } });
  for (const b of both(held)) has(b, `Release gate (JSON): [{"consumer":null,"dependency":"lib","strategy":"local","gate":"held"}]${tail}`);
  const released = fixture({ config: twoRepo, job: { repos }, events: [ev('interim-released', 5, { repo: 'lib', version: '1.2.0' })] });
  for (const b of both(released)) has(b, `Release gate (JSON): [{"consumer":null,"dependency":"lib","strategy":"local","gate":"released","version":"1.2.0"}]${tail}`);
  // The line follows the protected-paths line, and the approver brief stays within 25 lines.
  const lines = brief(held, 'approver').split('\n');
  assert.ok(lines[lines.findIndex((l) => l.startsWith('Protected paths: ')) + 1].startsWith('Release gate (JSON): '));
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assertShape(brief(fixture(), 'approver'), 'approver');
});

test('integrator brief carries strategy and conflicts', () => {
  const b = brief(fixture(), 'integrator', { strategy: 'merge', integration: { conflicts: ['a.ts'], fix: true } });
  has(b, 'Strategy: merge');
  has(b, 'Conflicts: ["a.ts"]');
  has(b, `Integration review: ${path.join(JOB_DIR, 'review', 'integration', 'code.md')}`);
  assert.ok(!brief(fixture(), 'integrator', { integration: { conflicts: [] } }).includes('Integration review:'));
});

test('judge brief names the eval task', () => {
  const b = brief(fixture({ job: { kind: 'eval', eval: { run: 'r', task: 'hello' } } }), 'judge');
  has(b, `Eval task: ${path.join('/repo', '.forge', 'evals', 'hello')}`);
  has(b, `Output: ${path.join(JOB_DIR, 'eval-judge.md')}`);
});

test('every role brief has the fixed shape', () => {
  for (const [role, ctx] of ROLES) assertShape(brief(fixture({ files: ['spec', 'request'] }), role, ctx), role);
});

test('verifier brief is paths only', () => {
  const input = path.join(JOB_DIR, 'verify', 'round-1-verifiers-input.md');
  const answers = path.join(JOB_DIR, 'verify', 'round-1-verifier-answers.md');
  const f = fixture({ job: { round: 1, stage: 'verify' }, present: [input] });
  const b = brief(f, 'verifier', { verifiers: 3 });
  has(b, 'Role: verifier');
  has(b, `Inputs: ${input}`);
  has(b, `Output: ${answers}`);
  has(b, 'Verifiers: 3 selected');
  // Paths, ids, numbers and fixed text: no line beyond the shared ones and the count.
  const extra = b.split('\n').filter((l) => !LABELS.some((label) => l.startsWith(label)) && !l.startsWith('Untrusted: ') && l !== REPLY_LINE);
  assert.deepEqual(extra, ['Verifiers: 3 selected']);
});

test('reviewers and approver read the verifiers report', () => {
  const report = path.join(JOB_DIR, 'verify', 'round-1-verifiers.md');
  const inputs = (b: string) => b.split('\n').find((l) => l.startsWith('Inputs: '))!.slice('Inputs: '.length).split(', ');
  const withReport = fixture({ job: { round: 1 }, files: ['spec', 'build'], present: [report] });
  const without = fixture({ job: { round: 1 }, files: ['spec', 'build'] });
  for (const role of ['reviewer:code', 'approver']) {
    const ctx: RoleContext = role === 'approver' ? {} : { lens: 'code' };
    assert.ok(inputs(brief(withReport, role, ctx)).includes(report), `${role} reads the report`);
    assert.ok(!inputs(brief(without, role, ctx)).includes(report), `${role} without a report`);
  }
});

test('member repos are listed after the worktree line', () => {
  const root = { repo: null, worktree: '/repo.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false };
  const lib = { repo: 'lib', worktree: '/lib.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false };
  const docs = { repo: 'docs', worktree: null, branch: null, base: 'release/1.x', pr: null, verifyOnly: true };
  const f = fixture({ files: ['spec', 'tasks'], job: { repos: [root, lib, docs] } });
  const lines = brief(f, 'builder').split('\n');
  const at = lines.findIndex((l) => l.startsWith('Worktree: '));
  assert.equal(lines[at + 1], 'Repo lib: /lib.worktrees/j · branch forge/j · base main');
  assert.equal(lines[at + 2], 'Repo docs: none · branch none (verify only) · base release/1.x');
  assert.ok(lines[at + 3].startsWith('Base branch: '));
  const single = brief(fixture({ files: ['spec', 'tasks'] }), 'builder');
  assert.ok(!single.includes('Repo '), 'a single-repo brief has no Repo line');
  const job = normalizeJob({ id: 'j', branch: 'forge/j', base: 'main', worktree: '/repo.worktrees/j' });
  assert.equal('repos' in jobPathMap('/repo', defaults(), job), false, 'a single-repo path map has no repos key');
  assert.deepEqual(jobPathMap('/repo', defaults(), { ...job, repos: [root, lib, docs] }).repos, { lib: '/lib.worktrees/j', docs: null });
});

test('downstream consumer lines in the builder brief', () => {
  const root = { repo: null, worktree: '/repo.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false };
  const a = { repo: 'app-a', worktree: '/app-a.worktrees/j', branch: null, base: 'main', pr: null, verifyOnly: true };
  const docs = { repo: 'docs', worktree: null, branch: null, base: 'main', pr: null, verifyOnly: true };
  const added = [ev('job-repo-added', 1, { repo: 'app-a', verifyOnly: true, downstream: true }), ev('job-repo-added', 1, { repo: 'docs', verifyOnly: true })];
  const failing: VerifyRun = { round: 1, attempt: 1, sha: 's', ok: false, at: null, file: 'verify/round-1.md', failure: 'test', repos: [{ repo: 'app-a', sha: 's', ok: false, failure: 'test' }, { repo: 'docs', sha: 's', ok: false, failure: 'lint' }] };
  const f = fixture({ files: ['spec', 'tasks'], job: { round: 2, repos: [root, a, docs], verifyRuns: [failing] }, events: added });
  const lines = brief(f, 'builder', { rework: ['verify'] }).split('\n');
  assert.ok(lines.includes('Repo app-a: /app-a.worktrees/j · branch none (verify only, downstream consumer) · base main'));
  assert.ok(lines.includes('Repo docs: none · branch none (verify only) · base main'), 'a verify-only repo a human added is not downstream');
  const line = 'Downstream failures (JSON): [{"repo":"app-a","failure":"test"}]: fix the library on this job, or run forge job repo propose j <repo> --reason "<what changes there>" to change the consumer too';
  assert.ok(lines.includes(line));
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.equal(lines.at(-1), REPLY_LINE);
  // Not without a verify rework, nor after a run the consumer passed, nor in a first-round brief.
  assert.ok(!brief(f, 'builder', { rework: ['review'] }).includes('Downstream failures'));
  assert.ok(!brief(f, 'builder').includes('Downstream failures'));
  const passed = fixture({ files: ['spec', 'tasks'], job: { round: 2, repos: [root, a, docs], verifyRuns: [{ ...failing, repos: [{ repo: 'app-a', sha: 's', ok: true, failure: null }, failing.repos![1]] }] }, events: added });
  assert.ok(!brief(passed, 'builder', { rework: ['verify'] }).includes('Downstream failures'));
  // Without the downstream event, neither line appears.
  const plain = brief(fixture({ files: ['spec', 'tasks'], job: { round: 2, repos: [root, a], verifyRuns: [failing] } }), 'builder', { rework: ['verify'] });
  assert.ok(!plain.includes('downstream consumer') && !plain.includes('Downstream failures'));
});

test('planner and spec-writer briefs carry the repo graph', () => {
  const graph = (c: any) => {
    c.repos = [{ name: 'lib', remote: 'https://example.com/lib.git', defaultBranch: 'main' }];
    c.components = [
      { name: 'core', repo: 'lib', path: '.', kind: 'library' },
      { name: 'app', path: '.', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }] },
    ];
  };
  const proposals = path.join(JOB_DIR, 'repo-proposals.md');
  const line = 'Project repos (JSON): [{"repo":"lib","onJob":false,"components":["core"],"usedBy":[{"component":"app","repo":null,"type":"build"}]}]';
  const f = fixture({ config: graph, files: ['request'], present: [proposals] });
  assert.equal(f.paths.repoProposals, proposals);
  for (const role of ['planner', 'spec-writer']) {
    const b = brief(f, role);
    has(b, line);
    assert.match(b, new RegExp(`^Inputs: .*${proposals.replace(/[.\\/]/g, '\\$&')}`, 'm'), role);
    assert.ok(!brief(fixture({ files: ['request'] }), role).includes('Project repos'), `${role}: single-repo has no line`);
    const inputs = brief(fixture({ config: graph, files: ['request'] }), role).split('\n').find((l) => l.startsWith('Inputs: '))!;
    assert.ok(!inputs.includes(proposals), `${role}: lists the file only when it exists`);
  }
  assert.ok(!brief(fixture({ config: graph, files: ['spec', 'tasks'] }), 'builder').includes('Project repos'), 'the builder gets no graph');
  const lib = { repo: 'lib', worktree: null, branch: null, base: 'main', pr: null, verifyOnly: false };
  const onJob = fixture({ config: graph, job: { repos: [{ repo: null } as any, lib] } });
  has(brief(onJob, 'planner'), line.replace('"onJob":false', '"onJob":true'));
});

test('planner and spec-writer prompts propose repos through the CLI', () => {
  for (const role of ['planner', 'spec-writer']) {
    const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'agents', `${role}.md`), 'utf8');
    assert.ok(text.includes('forge job repo propose <job> <repo> --reason'), `${role}: the propose command`);
    assert.ok(text.includes('Propose only names from that line'), `${role}: names from the Project repos line`);
    assert.ok(text.includes('never re-propose a rejected repo'), `${role}: no re-proposal`);
    assert.ok(text.includes('Never approve or reject a proposal yourself'), `${role}: never decides`);
  }
});

test('builder prompt states the token rules', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'agents', 'builder.md'), 'utf8');
  const rules = [
    'Read a file whole, once',
    "Don't re-read it in repeated `sed -n`, `head` or `cat` slices",
    'Change files only with Edit or Write, never with `python3`, `sed`, `perl` or heredoc rewrites',
    'Batch independent reads and commands into one message',
    'Combine checks into one command',
    "Use browser tools only for the ACs on your brief's `UI proof:` line",
    'Read pages as text (`get_page_text`, `read_page`) before you take any screenshot',
    "Take each UI AC's screenshots once, at the end of its phase",
  ];
  for (const r of rules) assert.ok(text.includes(r), `missing: ${r}`);
  assert.match(text.trim().split('\n').at(-1)!, /NEEDS-INPUT|runbook yes/, 'the reply contract stays last');
});

test('builder brief names the UI proof ACs or none', () => {
  const ui = 'UI proof: AC3, AC7 · browser tools only for these ACs; read pages as text before any screenshot; screenshot each once, at the end of its phase';
  const none = 'UI proof: none · no AC needs a rendered UI, so do not use browser tools';
  const code = path.join(JOB_DIR, 'review', 'round-1', 'code.md');
  for (const [job, ctx] of [[{ round: 1 }, {}], [{ round: 2 }, { rework: ['review'], reworkReviews: [code] }], [{ round: 2 }, { rework: ['answer'] }]] as [any, RoleContext][]) {
    has(brief(fixture({ files: ['spec', 'tasks'], present: [code], job, spec: { uiAcs: ['AC3', 'AC7'] } }), 'builder', ctx), ui);
    has(brief(fixture({ files: ['spec', 'tasks'], present: [code], job }), 'builder', ctx), none);
  }
  for (const role of ['approver', 'planner']) assert.ok(!brief(fixture({ spec: { uiAcs: ['AC3'] } }), role).includes('UI proof:'), `${role}: builder only`);
  // From spec.md on disk, through loadStepInput.
  const repo = tempRepo();
  try {
    const config = defaults();
    const job = createJob(repo.dir, config, { title: 'UI', body: 'x' });
    fs.writeFileSync(path.join(jobDir(repo.dir, job.id), 'spec.md'), '# S\n## Acceptance criteria\n- AC1 — a test\n- AC2 — saved as `screenshots/ac2-x-375.png`\n');
    has(renderBrief(loadStepInput(repo.dir, config, job.id), roleBrief(loadStepInput(repo.dir, config, job.id), 'builder')), ui.replace('AC3, AC7', 'AC2'));
  } finally {
    repo.cleanup();
  }
});

test('briefs carry the instructions line only with instruction files', () => {
  const line = 'Instructions: read each file in paths.instructions once; skip one already in your context as project instructions unless this job changes it; where a file opens with an Essentials section, read its other sections only when your task touches them.';
  assert.equal(INSTRUCTIONS_LINE, line);
  const withFiles = fixture({ files: ['spec', 'request'] });
  withFiles.paths = { ...withFiles.paths, instructions: ['/repo.worktrees/j/AGENTS.md'] };
  const without = fixture({ files: ['spec', 'request'] });
  without.paths = { ...without.paths, instructions: [] };
  for (const [role, ctx] of ROLES) {
    const b = brief(withFiles, role, ctx);
    assertShape(b, role);
    assert.equal(b.split('\n')[9], line, `${role}: right after Effort`);
    assert.ok(!brief(without, role, ctx).includes('Instructions:'), `${role}: no line without instruction files`);
  }
});

test('backing services line', () => {
  const secret = ['pw', 'never', 'shown'].join('-');
  const withBacking = (c: any) =>
    (c.backing = [
      { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], env: { POSTGRES_PASSWORD: secret }, url: `postgres://u:${secret}@{host}:{port}/app` },
      { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] },
      { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' },
    ]);
  const f = { ...fixture({ config: withBacking }), backing: { job: { v: 1 as const, ports: { postgres: { 5432: 4101 } } }, shared: { v: 1 as const, ports: { redis: { 6379: 4150 } } } } };
  const line = 'Backing services: postgres per-job 127.0.0.1:4101; redis shared 127.0.0.1:4150; queue external. Reach them through $FORGE_BACKING_<NAME>_* in configured commands.';
  for (const [role, ctx] of [['builder', {}], ['builder', { rework: ['review'] }], ['reviewer:code', { lens: 'code' }]] as [string, RoleContext][]) {
    const b = brief(f, role, ctx);
    has(b, line);
    assert.ok(!b.includes(secret) && !b.includes('mq.internal') && !b.includes('postgres://'), 'no env value or url');
  }
  // Not up yet: names and isolations only.
  has(brief({ ...f, backing: { job: { v: 1, ports: {} }, shared: { v: 1, ports: {} } } }, 'builder'), 'Backing services: postgres per-job; redis shared; queue external. Reach them through $FORGE_BACKING_<NAME>_* in configured commands.');
  for (const role of ['builder', 'reviewer:code']) assert.ok(!brief(fixture(), role, { lens: 'code' }).includes('Backing services'), 'absent without entries');
});
