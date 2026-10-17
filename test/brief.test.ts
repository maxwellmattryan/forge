// Agent briefs from `forge job step` (issue #68): at most 25 lines, absolute paths, the role's own
// lines, and never the contents of a job file or an agent's reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { REPLY_LINE, jobPathMap, renderBrief, roleBrief } from '../lib/brief.ts';
import type { RoleContext } from '../lib/brief.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { WAITING_ON, normalizeJob } from '../lib/schema.ts';
import { gateTell, loadStepInput, step } from '../lib/step.ts';
import type { Stage, StepInput } from '../lib/types.ts';
import { JOB_DIR, ag, fixture } from './step-fixture.ts';

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
  has(b, 'Dev server: http://localhost:4123');
  const code = brief(f, 'reviewer:code', { lens: 'code' });
  assert.ok(code.includes('Checklist: /') && !code.includes('Dev server'));
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
