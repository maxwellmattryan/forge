// The page's project: which `/api` paths projectApi prefixes with `/api/p/<project>/` (never the
// machine's own), and which project names it keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentProject, isNotRegisteredError, notRegistered, projectApi, projectFromSearch, setProject } from './project.ts';
import { errorText } from './util.ts';

test('projectApi prefixes project paths and leaves the machine paths alone', () => {
  setProject(null);
  assert.throws(() => projectApi('/api/state'), /no project is selected/);
  assert.equal(projectApi('/api/about'), '/api/about', 'a machine path needs no project');
  setProject('a');
  assert.equal(currentProject(), 'a');
  const rows: [string, string][] = [
    ['/api/state', '/api/p/a/state'],
    ['/api/jobs/j%201/file?path=request.md', '/api/p/a/jobs/j%201/file?path=request.md'],
    ['/api/events?session=_inbox', '/api/p/a/events?session=_inbox'],
    ['/api/about', '/api/about'],
    ['/api/projects', '/api/projects'],
    ['/api/projects/events', '/api/projects/events'],
    ['/api/p/a/state', '/api/p/a/state'],
    ['/forge.png', '/forge.png'],
    // Only the exact machine names: a project route that merely starts with one is still prefixed.
    ['/api/aboutx', '/api/p/a/aboutx'],
    ['/api/project', '/api/p/a/project'],
  ];
  for (const [path, want] of rows) assert.equal(projectApi(path), want, path);
});

test('setProject keeps only a valid project name', () => {
  for (const bad of ['A', '../x', 'a/b', '', 'a'.repeat(65)]) {
    setProject(bad);
    assert.equal(currentProject(), null, JSON.stringify(bad));
  }
});

test('projectFromSearch reads ?project=', () => {
  assert.equal(projectFromSearch('?project=web'), 'web');
  assert.equal(projectFromSearch('?x=1&project=a.b'), 'a.b');
  assert.equal(projectFromSearch('?project='), null);
  assert.equal(projectFromSearch(''), null);
});

test('an unregistered project is told apart from a lost connection, and a long name is cut', () => {
  // The server's 404 body, through the error text the page reads.
  const body = JSON.stringify({ error: 'no registered project "other"' });
  assert.equal(isNotRegisteredError(errorText(body)), true);
  assert.equal(isNotRegisteredError(errorText('Failed to fetch')), false, 'no answer at all is a lost connection');
  assert.equal(isNotRegisteredError(errorText(JSON.stringify({ error: 'not found' }))), false);
  assert.equal(notRegistered('other'), 'No registered project "other" on this machine.');
  assert.equal(notRegistered('x'.repeat(200)), `No registered project "${'x'.repeat(64)}" on this machine.`, 'cut like the server');
});
