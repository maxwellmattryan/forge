// What each pipeline role writes, for the stub claude (fake-claude.mjs FAKE_CLAUDE_ROLES): called before a role child's
// working result with { agent, brief, cwd, env }, it writes the role's output files from the brief's `Output:` line in the
// formats step and verify read, and returns the reply's text. A role it doesn't know writes nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The value of the brief's `<name>: ` line, or null. */
const line = (/** @type {string} */ brief, /** @type {string} */ name) => {
  const l = brief.split('\n').find((x) => x.startsWith(`${name}: `));
  return l ? l.slice(name.length + 2) : null;
};

const write = (/** @type {string} */ file, /** @type {string} */ text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const SPEC = `# A small change

Size: S
Complexity: low
Components: library
Needs design: no
Needs infra: none

## Goal
Add one file.

## Acceptance criteria
- [ ] AC1 — the file exists · Proven by: command \`test -f added.txt\`

## Approach
Write the file.

## Tasks
- [ ] 1. Add the file.
`;

/**
 * @param {{ agent: string | null, brief: string, cwd: string, env: NodeJS.ProcessEnv }} run
 * @returns {string | undefined} the reply's text
 */
export default function role({ agent, brief, cwd, env }) {
  const outputs = (line(brief, 'Output') ?? '').split(', ').filter((p) => path.isAbsolute(p));
  const round = Number(line(brief, 'Round') ?? '1');
  switch (agent) {
    case 'forge:planner':
      // FAKE_PLAN_SPLIT: two children, the second depending on the first.
      if (env.FAKE_PLAN_SPLIT) {
        write(outputs[0], 'PLAN: SPLIT\n\nTwo pieces.\n\n## Jobs\n1. First piece — the first half. Depends on: -\n2. Second piece — the second half. Depends on: #1\n\n## External\n- None\n');
        return 'PLAN: SPLIT · 2 jobs';
      }
      write(outputs[0], 'PLAN: SINGLE\n\nOne job: add one file.\n');
      return 'PLAN: SINGLE · one job';
    case 'forge:digest':
      write(outputs[0], '# Friction\n\nNone found.\n');
      return 'DIGEST: done · 0 findings';
    case 'forge:retro': {
      // FAKE_RETRO_EMPTY: the retro proposes nothing and writes no spec.md.
      const retro = outputs.find((p) => p.endsWith('retro.md'));
      if (retro) write(retro, '# Retro\n\nToo little data.\n');
      if (env.FAKE_RETRO_EMPTY) return 'RETRO: nothing to propose';
      write(outputs.find((p) => p.endsWith('spec.md')) ?? outputs[0], SPEC);
      return 'RETRO: done · 1 change';
    }
    case 'forge:spec-writer':
      write(outputs[0], SPEC);
      return 'SPEC: done · 1 AC';
    case 'forge:builder': {
      // A commit in the worktree, as the builder makes through `forge git commit`. A rerun in the same round (after a
      // failed verify) adds a line, so every run has a change to commit.
      const added = path.join(cwd, 'added.txt');
      const prev = fs.existsSync(added) ? fs.readFileSync(added, 'utf8') : '';
      write(added, prev.startsWith(`round ${round}\n`) ? `${prev}round ${round}\n` : `round ${round}\n`);
      const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
      git('add', 'added.txt');
      git('-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', `feat: add the file (round ${round})`);
      const tasks = outputs.find((p) => p.endsWith('tasks.md'));
      if (tasks) write(tasks, '- [x] 1. Add the file.\n');
      const build = outputs.find((p) => p.endsWith('build.md')) ?? outputs[0];
      write(build, `## Round ${round}\nChanges: added.txt\nTests: none\nAcceptance criteria:\n| AC | Proof | Result |\n|---|---|---|\n| AC1 | command \`test -f added.txt\` | pass |\n`);
      return 'BUILD: done · 1 commit · tasks 1/1 · tests pass';
    }
    case 'forge:reviewer':
      write(outputs[0], 'VERDICT: PASS\n\n## Summary\nLooks right.\n\n## Findings\nNone.\n');
      return 'VERDICT: PASS';
    case 'forge:approver': {
      const decision = outputs.find((p) => p.endsWith('decision.md')) ?? outputs[0];
      write(decision, 'APPROVE\n\nAuto-merge eligible: no\n\nThe change is small and every lens passed.\n');
      const pr = outputs.find((p) => p.endsWith('pr.md'));
      if (pr) write(pr, '## Summary\nAdds one file.\n');
      return 'DECISION: APPROVE';
    }
    default:
      return undefined;
  }
}
