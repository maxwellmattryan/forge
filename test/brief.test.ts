// Agent briefs from `forge job step` (issue #68): at most 25 lines, absolute paths, the role's own
// lines, and never the contents of a job file or an agent's reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { REPLY_LINE, renderBrief, roleBrief } from '../lib/brief.ts';
import type { RoleContext } from '../lib/brief.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { WAITING_ON } from '../lib/schema.ts';
import { gateTell, loadStepInput, step } from '../lib/step.ts';
import type { Stage, StepInput } from '../lib/types.ts';
import { JOB_DIR, ag, fixture } from './step-fixture.ts';

const SENTINEL = 'ZZSENTINEL-7f3a';
const LABELS = ['Job id: ', 'Role: ', 'Round: ', 'Worktree: ', 'Base branch: ', 'Job paths (JSON): ', 'Inputs: ', 'Output: '];

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
];

function assertShape(brief: string, role: string) {
  const lines = brief.split('\n');
  assert.ok(lines.length <= 25, `${role}: ${lines.length} lines`);
  LABELS.forEach((label, i) => assert.ok(lines[i].startsWith(label), `${role}: line ${i + 1} is ${label}`));
  assert.ok(path.isAbsolute(lines[3].slice('Worktree: '.length)), `${role}: worktree is absolute`);
  for (const p of lines[7].slice('Output: '.length).split(', ')) assert.ok(path.isAbsolute(p), `${role}: output ${p} is absolute`);
  const inputs = lines[6].slice('Inputs: '.length);
  if (inputs !== 'none') for (const p of inputs.split(', ')) assert.ok(path.isAbsolute(p), `${role}: input ${p} is absolute`);
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
    const summary = `NEEDS-INPUT ${s}`;
    updateJob(root, job.id, (j) => {
      j.worktree = root;
      j.round = 1;
      j.reviewers = ['code', 'ui'];
      j.agents = Object.fromEntries(['planner', 'spec-writer', 'designer', 'builder', 'reviewer:code', 'reviewer:ui', 'approver', 'integrator', 'judge'].map((r) => [r, { ...ag(1, 1, 2), summary }]));
      j.eval = { run: 'r', task: 't' };
    });

    const seen: string[] = [];
    const stages: Stage[] = ['backlog', 'plan', 'spec', 'design', 'build', 'verify', 'review', 'decide', 'integrate', 'pr'];
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
  const f = fixture({ files: ['spec', 'tasks', 'feedback'], job: { round: 2 }, config: (c) => ((c.infra.mode = 'plan-only'), (c.infra.allowed = ['terraform plan'])) });
  const b = brief(f, 'builder', { rework: ['review', 'feedback'] });
  has(b, 'Rework: review, feedback');
  has(b, 'Infra: mode plan-only · allowed ["terraform plan"]');
  assert.ok(b.includes(path.join(JOB_DIR, 'feedback.md')));
  assert.ok(!brief(f, 'builder').includes('Rework:'));
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
