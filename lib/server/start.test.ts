// The dashboard's route table: each method and path reaches exactly its handler with its captured
// params, and everything else (another method, a trailing slash, an id outside a route's character
// set) matches nothing, so dispatch answers it 404. In-process: no server is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, matchRoute } from './start.ts';
import { getAsset, getLogo, getPage } from './static.ts';
import { getConfig, postBudgetAck, postConfig } from './routes/config.ts';
import { getEnvironmentLogs, getEnvironments, getJobEnvironment, postJobEnvironment } from './routes/environment.ts';
import { getJob, getJobFile, getRequests, postJob, postJobBudget, postJobDelete, postJobEffort, postJobMerge, postJobRepos, postRequest, postRunOrEditor } from './routes/jobs.ts';
import { getAbout, getBacklog, getDoctor, getEvals, getEvalsCompare, getGitHubPreview, getProject, getRoster, getState, getStats, getSupportBundle, postFocus } from './routes/misc.ts';
import { getEvents, getSessionLog, postDaemon, postDaemonMode, postPermission } from './routes/office.ts';
import { getTranscript, getTranscriptEvents } from './routes/transcripts.ts';
import type { Handler } from './types.ts';

test('the route table sends each method and path to its handler, and nothing else', () => {
  const hits: [string, string, Handler, string[]][] = [
    ['GET', '/', getPage, []],
    ['GET', '/index.html', getPage, []],
    ['GET', '/assets/index-Fx1.js', getAsset, []],
    ['GET', '/forge.png', getLogo, []],
    ['GET', '/api/state', getState, []],
    ['GET', '/api/events', getEvents, []],
    ['GET', '/api/daemons/log', getSessionLog, []],
    ['GET', '/api/stats', getStats, []],
    ['GET', '/api/evals', getEvals, []],
    ['GET', '/api/evals/compare', getEvalsCompare, []],
    ['GET', '/api/requests', getRequests, []],
    ['GET', '/api/roster', getRoster, []],
    ['GET', '/api/project', getProject, []],
    ['GET', '/api/backlog', getBacklog, []],
    ['GET', '/api/config', getConfig, []],
    ['GET', '/api/about', getAbout, []],
    ['GET', '/api/environments', getEnvironments, []],
    ['GET', '/api/jobs/j-1/environment', getJobEnvironment, ['j-1']],
    ['GET', '/api/jobs/a%20b/environment', getJobEnvironment, ['a%20b']],
    ['GET', '/api/jobs/j-1/environment/logs', getEnvironmentLogs, ['j-1']],
    ['POST', '/api/jobs/j-1/environment', postJobEnvironment, ['j-1']],
    ['GET', '/api/doctor', getDoctor, []],
    ['GET', '/api/doctor/bundle', getSupportBundle, []],
    ['GET', '/api/github/preview', getGitHubPreview, []],
    ['POST', '/api/jobs', postJob, []],
    ['GET', '/api/jobs/j-1', getJob, ['j-1']],
    ['GET', '/api/jobs/j-1/transcript', getTranscript, ['j-1']],
    ['GET', '/api/jobs/j-1/transcript/events', getTranscriptEvents, ['j-1']],
    ['GET', '/api/jobs/j-1/file', getJobFile, ['j-1', 'file']],
    ['GET', '/api/jobs/j-1/raw', getJobFile, ['j-1', 'raw']],
    ['POST', '/api/requests', postRequest, []],
    ['POST', '/api/config', postConfig, []],
    ['POST', '/api/budget/ack', postBudgetAck, []],
    ['POST', '/api/daemon/permission', postPermission, []],
    ['POST', '/api/daemon/mode', postDaemonMode, []],
    ['POST', '/api/daemon', postDaemon, []],
    ['POST', '/api/jobs/j-1/effort', postJobEffort, ['j-1']],
    ['POST', '/api/jobs/j-1/budget', postJobBudget, ['j-1']],
    ['POST', '/api/jobs/j-1/delete', postJobDelete, ['j-1']],
    ['POST', '/api/jobs/j-1/merge', postJobMerge, ['j-1']],
    ['POST', '/api/jobs/j-1/repos', postJobRepos, ['j-1']],
    ['POST', '/api/focus', postFocus, []],
    ['POST', '/api/jobs/j-1/run', postRunOrEditor, ['j-1', 'run']],
    ['POST', '/api/jobs/j-1/editor', postRunOrEditor, ['j-1', 'editor']],
  ];
  const misses: [string | undefined, string][] = [
    ['HEAD', '/api/state'],
    ['PUT', '/api/state'],
    ['POST', '/api/state'],
    ['OPTIONS', '/api/jobs'],
    [undefined, '/api/state'],
    ['GET', '/api/jobs'],
    ['GET', '/api/jobs/'],
    ['GET', '/api/state/'],
    ['GET', '/api/nope'],
    ['GET', '/index.htm'],
    ['GET', '/assets'],
    ['GET', '/api/jobs/a%20b'],
    ['GET', '/api/jobs/j-1/effort'],
    ['GET', '/api/jobs/j-1/run'],
    ['GET', '/api/jobs/j-1/file/x'],
    ['POST', '/api/jobs/j-1'],
    ['POST', '/api/jobs/j-1/environment/logs'],
    ['POST', '/api/jobs/j-1/transcript'],
  ];
  const matched = new Set<unknown>();
  for (const [method, pathname, handler, params] of hits) {
    const hit = matchRoute(ROUTES, method, pathname);
    assert.ok(hit, `${method} ${pathname} matches a route`);
    assert.equal(hit.route.handler, handler, `${method} ${pathname} → ${handler.name}, not ${hit.route.handler.name}`);
    assert.deepEqual(hit.params, params, `${method} ${pathname} params`);
    matched.add(hit.route);
  }
  for (const [method, pathname] of misses) assert.equal(matchRoute(ROUTES, method, pathname), null, `${method} ${pathname} matches nothing`);
  const unmatched = ROUTES.filter((r) => !matched.has(r)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(unmatched, [], 'every route is the match of some row');
});
