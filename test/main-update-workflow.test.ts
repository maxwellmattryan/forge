// .github/workflows/main-update.yml builds the dashboard that `npm run release` puts on main. Nothing in it
// may write: the maintainer pushes main. The shared checks in test/workflow-lint.ts hold that, its pins
// and that it holds no credential; the gate below holds which code may build the artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { credentialRefs, dependencyCaches, excessPermissions, forbiddenTriggers, loadWorkflow, persistedCredentials, runExpressions, secretLeaks, triggersOf, unpinnedActions } from './workflow-lint.ts';

const WF = loadWorkflow('main-update.yml');
const ALLOWED = {};
const ON_DEVELOP = "github.ref == 'refs/heads/develop'";

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const flags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);

/**
 * Only develop's own commits may build the dashboard-dist artifact scripts/release.ts ships to main: a PR
 * or another workflow's run would build PR code under this workflow's trusted name.
 */
function gateProblems(wf: any): string[] {
  const out = forbiddenTriggers(wf);
  for (const e of triggersOf(wf)) if (e !== 'push' && e !== 'workflow_dispatch') out.push(`only a push or a manual run may build, not ${e}`);
  if (!isDeepStrictEqual(wf?.on?.push, { branches: ['develop'] })) out.push('the push must be limited to branches: [develop]');
  // An input would be a value a caller chooses, one step from a run script.
  const dispatch = wf?.on?.workflow_dispatch;
  if (dispatch !== null && dispatch !== undefined && !(typeof dispatch === 'object' && Object.keys(dispatch).length === 0))
    out.push('workflow_dispatch must take no inputs');
  // workflow_dispatch can name any branch, so every job checks the ref itself.
  for (const [id, job] of Object.entries<any>(wf?.jobs ?? {})) if (job?.if !== ON_DEVELOP) out.push(`job ${id} must run only if ${ON_DEVELOP}`);
  return out;
}

test('only develop builds the artifact, and nothing interpolates into a run script', () => {
  assert.deepEqual(gateProblems(WF), []);
  assert.deepEqual(runExpressions(WF), []);
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule']) {
    flags(gateProblems(mutate((wf) => { wf.on[event] = null; })), `${event} added`);
  }
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'main']; })), 'a second branch');
  flags(gateProblems(mutate((wf) => { delete wf.on.push.branches; })), 'every branch');
  flags(gateProblems(mutate((wf) => { wf.on.workflow_dispatch = { inputs: { ref: { type: 'string' } } }; })), 'workflow_dispatch inputs');
  flags(gateProblems(mutate((wf) => { delete wf.jobs.build.if; })), 'no ref guard');
  flags(gateProblems(mutate((wf) => { wf.jobs.build.if = `${ON_DEVELOP} || true`; })), 'a loosened ref guard');
  flags(runExpressions(mutate((wf) => { wf.jobs.build.steps.find((s: any) => s.run === 'npm ci').run = 'echo "${{ github.event.head_commit.message }}"\nnpm ci'; })), 'the commit message interpolated into run');
});

test('the build has a read-only token, pins every action and holds no credential', () => {
  assert.deepEqual(unpinnedActions(WF), []);
  assert.deepEqual(excessPermissions(WF, ALLOWED), []);
  assert.deepEqual(secretLeaks(WF), []);
  assert.deepEqual(persistedCredentials(WF), []);
  assert.deepEqual(dependencyCaches(WF), []);
  // It runs on every develop push and needs no token beyond the read-only checkout.
  assert.deepEqual(credentialRefs(WF), []);

  flags(excessPermissions(mutate((wf) => { wf.permissions = { contents: 'write' }; }), ALLOWED), 'write at the top level');
  flags(excessPermissions(mutate((wf) => { wf.jobs.build.permissions = { contents: 'write' }; }), ALLOWED), 'write on build');
  flags(excessPermissions(mutate((wf) => { delete wf.permissions; }), ALLOWED), 'the default token');
  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps.at(-1).uses = 'actions/upload-artifact@v7'; })), 'an unpinned action');
  flags(persistedCredentials(mutate((wf) => { delete wf.jobs.build.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
  flags(secretLeaks(mutate((wf) => { wf.jobs.build.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a job-level token');
  flags(dependencyCaches(mutate((wf) => { delete wf.jobs.build.steps[1].with['package-manager-cache']; })), 'setup-node caching');
});
