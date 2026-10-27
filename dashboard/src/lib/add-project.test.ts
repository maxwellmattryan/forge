// The Add project dialog: the body it posts (or the field it stops at) and where the server's reply leads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addProjectBody, addProjectOutcome } from './add-project.ts';
import type { MachineProjectSummary } from './types.ts';

test('addProjectBody', () => {
  assert.deepEqual(addProjectBody('  /src/app  ', ''), { body: { path: '/src/app' } }, 'trimmed, a blank name left out');
  assert.deepEqual(addProjectBody('/src/app', '   '), { body: { path: '/src/app' } });
  assert.deepEqual(addProjectBody('~', ''), { body: { path: '~' } });
  assert.deepEqual(addProjectBody('~/src/app', ' my-app '), { body: { path: '~/src/app', name: 'my-app' } });
  assert.deepEqual(addProjectBody('C:\\src\\app', 'a.b_c-1'), { body: { path: 'C:\\src\\app', name: 'a.b_c-1' } });
  assert.deepEqual(addProjectBody('', 'x'), { error: 'pathRequired' });
  assert.deepEqual(addProjectBody('   ', ''), { error: 'pathRequired' });
  assert.deepEqual(addProjectBody('src/app', ''), { error: 'pathRelative' });
  assert.deepEqual(addProjectBody('./app', ''), { error: 'pathRelative' });
  assert.deepEqual(addProjectBody('~bob/app', ''), { error: 'pathRelative' }, "another user's home");
  for (const bad of ['Bad Name', 'UPPER', '-lead', '.lead', 'a/b', 'a'.repeat(65)]) assert.deepEqual(addProjectBody('/src/app', bad), { error: 'nameInvalid' }, bad);
  assert.deepEqual(addProjectBody('/src/app', 'a'.repeat(64)), { body: { path: '/src/app', name: 'a'.repeat(64) } });
});

test('addProjectOutcome', () => {
  const summary = (over: Partial<MachineProjectSummary> = {}): MachineProjectSummary => ({ name: 'app', path: '/src/app', status: 'ok', loaded: true, jobs: { active: 0, waiting: 0 }, latest: null, daemon: null, ...over });
  assert.deepEqual(addProjectOutcome({ added: true, project: summary() }), { kind: 'open', hash: '#/p/app/project', added: true });
  assert.deepEqual(addProjectOutcome({ added: false, project: summary() }), { kind: 'open', hash: '#/p/app/project', added: false }, 'already registered still opens');
  assert.deepEqual(addProjectOutcome({ added: true, project: summary({ loaded: false, jobs: null }) }), { kind: 'unavailable', name: 'app' }, 'not loaded');
  assert.deepEqual(addProjectOutcome({ added: true, project: summary({ status: 'missing', loaded: false }) }), { kind: 'unavailable', name: 'app' }, 'missing');
  assert.deepEqual(addProjectOutcome({ added: true, project: summary({ name: 'Bad/Name' }) }), { kind: 'unavailable', name: 'Bad/Name' }, 'a name the router refuses');
});
