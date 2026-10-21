// .github/workflows/main-update.yml builds the dashboard that `npm run release` puts on main. Nothing in it
// may write: the maintainer pushes main. The shared checks in test/workflow-lint.ts hold that, its pins
// and that it holds no credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialRefs, excessPermissions, loadWorkflow, persistedCredentials, secretLeaks, unpinnedActions } from './workflow-lint.ts';

const WF = loadWorkflow('main-update.yml');
const ALLOWED = {};

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const flags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);

test('the build has a read-only token, pins every action and holds no credential', () => {
  assert.deepEqual(unpinnedActions(WF), []);
  assert.deepEqual(excessPermissions(WF, ALLOWED), []);
  assert.deepEqual(secretLeaks(WF), []);
  assert.deepEqual(persistedCredentials(WF), []);
  // It runs on every develop push and needs no token beyond the read-only checkout.
  assert.deepEqual(credentialRefs(WF), []);

  flags(excessPermissions(mutate((wf) => { wf.permissions = { contents: 'write' }; }), ALLOWED), 'write at the top level');
  flags(excessPermissions(mutate((wf) => { wf.jobs.build.permissions = { contents: 'write' }; }), ALLOWED), 'write on build');
  flags(excessPermissions(mutate((wf) => { delete wf.permissions; }), ALLOWED), 'the default token');
  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps.at(-1).uses = 'actions/upload-artifact@v7'; })), 'an unpinned action');
  flags(persistedCredentials(mutate((wf) => { delete wf.jobs.build.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
  flags(secretLeaks(mutate((wf) => { wf.jobs.build.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a job-level token');
});
