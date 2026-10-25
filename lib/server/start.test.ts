// The dashboard's two route tables: each method and path reaches exactly its handler with its captured
// params, machine rows on the full path and project rows on the path after `/api/p/<name>`, and
// everything else (another method, a trailing slash, an id outside a route's character set, a bare
// project path in the machine table) matches nothing, so dispatch answers it 404. In-process: no server is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ROUTES, ROUTES, matchRoute } from './start.ts';
import { getAsset, getLogo, getPage } from './static.ts';
import { getConfig, postBudgetAck, postConfig } from './routes/config.ts';
import { getEnvironmentLogs, getEnvironments, getJobEnvironment, postJobEnvironment } from './routes/environment.ts';
import { getJob, getJobFile, getRequests, postJob, postJobBudget, postJobDelete, postJobEffort, postJobMerge, postJobRepos, postRequest, postRunOrEditor } from './routes/jobs.ts';
import { getProjects, getProjectsEvents } from './routes/machine.ts';
import { getAbout, getBacklog, getDoctor, getEvals, getEvalsCompare, getGitHubPreview, getProject, getRoster, getState, getStats, getSupportBundle, postFocus } from './routes/misc.ts';
import { getEvents, getSessionLog, postDaemon, postDaemonMode, postPermission } from './routes/office.ts';
import { getTranscript, getTranscriptEvents } from './routes/transcripts.ts';
import type { Route } from './types.ts';

type Hit = [string, string, unknown, string[]];

/** Every hit reaches its handler, every miss matches nothing, and every row is some hit's match. */
function checkTable(name: string, routes: readonly Route<any>[], hits: Hit[], misses: [string | undefined, string][]): void {
  const matched = new Set<unknown>();
  for (const [method, pathname, handler, params] of hits) {
    const hit = matchRoute(routes, method, pathname);
    assert.ok(hit, `${name}: ${method} ${pathname} matches a route`);
    assert.equal(hit.route.handler, handler, `${name}: ${method} ${pathname} → ${(handler as Function).name}, not ${hit.route.handler.name}`);
    assert.deepEqual(hit.params, params, `${name}: ${method} ${pathname} params`);
    matched.add(hit.route);
  }
  for (const [method, pathname] of misses) assert.equal(matchRoute(routes, method, pathname), null, `${name}: ${method} ${pathname} matches nothing`);
  const unmatched = routes.filter((r) => !matched.has(r)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(unmatched, [], `${name}: every route is the match of some row`);
}

test('the route table sends each method and path to its handler, and nothing else', () => {
  checkTable(
    'machine',
    ROUTES,
    [
      ['GET', '/', getPage, []],
      ['GET', '/index.html', getPage, []],
      ['GET', '/assets/index-Fx1.js', getAsset, []],
      ['GET', '/forge.png', getLogo, []],
      ['GET', '/api/about', getAbout, []],
      ['GET', '/api/projects', getProjects, []],
      ['GET', '/api/projects/events', getProjectsEvents, []],
    ],
    [
      ['POST', '/api/projects'],
      ['GET', '/api/projects/'],
      ['GET', '/api/state'],
      ['GET', '/api/events'],
      ['POST', '/api/requests'],
      ['GET', '/api/jobs/j-1'],
      ['GET', '/index.htm'],
      ['GET', '/assets'],
      ['HEAD', '/'],
      [undefined, '/api/about'],
    ],
  );
  checkTable(
    'project',
    PROJECT_ROUTES,
    [
      ['GET', '/state', getState, []],
      ['GET', '/events', getEvents, []],
      ['GET', '/daemons/log', getSessionLog, []],
      ['GET', '/stats', getStats, []],
      ['GET', '/evals', getEvals, []],
      ['GET', '/evals/compare', getEvalsCompare, []],
      ['GET', '/requests', getRequests, []],
      ['GET', '/roster', getRoster, []],
      ['GET', '/project', getProject, []],
      ['GET', '/backlog', getBacklog, []],
      ['GET', '/config', getConfig, []],
      ['GET', '/environments', getEnvironments, []],
      ['GET', '/jobs/j-1/environment', getJobEnvironment, ['j-1']],
      ['GET', '/jobs/a%20b/environment', getJobEnvironment, ['a%20b']],
      ['GET', '/jobs/j-1/environment/logs', getEnvironmentLogs, ['j-1']],
      ['POST', '/jobs/j-1/environment', postJobEnvironment, ['j-1']],
      ['GET', '/doctor', getDoctor, []],
      ['GET', '/doctor/bundle', getSupportBundle, []],
      ['GET', '/github/preview', getGitHubPreview, []],
      ['POST', '/jobs', postJob, []],
      ['GET', '/jobs/j-1', getJob, ['j-1']],
      ['GET', '/jobs/j-1/transcript', getTranscript, ['j-1']],
      ['GET', '/jobs/j-1/transcript/events', getTranscriptEvents, ['j-1']],
      ['GET', '/jobs/j-1/file', getJobFile, ['j-1', 'file']],
      ['GET', '/jobs/j-1/raw', getJobFile, ['j-1', 'raw']],
      ['POST', '/requests', postRequest, []],
      ['POST', '/config', postConfig, []],
      ['POST', '/budget/ack', postBudgetAck, []],
      ['POST', '/daemon/permission', postPermission, []],
      ['POST', '/daemon/mode', postDaemonMode, []],
      ['POST', '/daemon', postDaemon, []],
      ['POST', '/jobs/j-1/effort', postJobEffort, ['j-1']],
      ['POST', '/jobs/j-1/budget', postJobBudget, ['j-1']],
      ['POST', '/jobs/j-1/delete', postJobDelete, ['j-1']],
      ['POST', '/jobs/j-1/merge', postJobMerge, ['j-1']],
      ['POST', '/jobs/j-1/repos', postJobRepos, ['j-1']],
      ['POST', '/focus', postFocus, []],
      ['POST', '/jobs/j-1/run', postRunOrEditor, ['j-1', 'run']],
      ['POST', '/jobs/j-1/editor', postRunOrEditor, ['j-1', 'editor']],
    ],
    [
      ['HEAD', '/state'],
      ['PUT', '/state'],
      ['POST', '/state'],
      ['OPTIONS', '/jobs'],
      [undefined, '/state'],
      ['GET', '/jobs'],
      ['GET', '/jobs/'],
      ['GET', '/state/'],
      ['GET', '/nope'],
      ['GET', '/api/state'],
      ['GET', '/about'],
      ['GET', '/projects'],
      ['GET', '/'],
      ['GET', '/jobs/a%20b'],
      ['GET', '/jobs/j-1/effort'],
      ['GET', '/jobs/j-1/run'],
      ['GET', '/jobs/j-1/file/x'],
      ['POST', '/jobs/j-1'],
      ['POST', '/jobs/j-1/environment/logs'],
      ['POST', '/jobs/j-1/transcript'],
    ],
  );
});
