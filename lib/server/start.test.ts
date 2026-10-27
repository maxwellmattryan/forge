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
import { getJob, getJobFile, getRequests, postJob, postJobBudget, postJobDelete, postJobEffort, postJobMerge, postJobRepos, postRequest, postRunOrEditor, postShelf } from './routes/jobs.ts';
import { getProjects, getProjectsEvents, getProjectsStats, postProject } from './routes/machine.ts';
import { getMandate, getMandateDraft, getMandates, postMandate, postMandateAction, postMandateDraft } from './routes/mandates.ts';
import { getAbout, getBacklog, getBacklogItem, getDoctor, getEvals, getEvalsCompare, getGitHubPreview, getProject, getRoster, getState, getStats, getSupportBundle, postFocus } from './routes/misc.ts';
import { getEvents, getSessionLog, postDaemon, postDaemonMode, postPermission } from './routes/office.ts';
import { getTranscript, getTranscriptEvents } from './routes/transcripts.ts';
import { getChat, getChatLog, getChats, postChat, postChatArchive, postChatMessage, postChatRename } from './routes/chats.ts';
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
      ['POST', '/api/projects', postProject, []],
      ['GET', '/api/projects/events', getProjectsEvents, []],
      ['GET', '/api/projects/stats', getProjectsStats, []],
    ],
    [
      ['POST', '/api/projects/'],
      ['POST', '/api/projects/stats'],
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
      ['GET', '/backlog/item', getBacklogItem, []],
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
      ['GET', '/mandates', getMandates, []],
      ['GET', '/mandates/g1', getMandate, ['g1']],
      ['POST', '/mandates', postMandate, []],
      ['POST', '/mandates/g1/edit', postMandateAction, ['g1', 'edit']],
      ['POST', '/mandates/g1/close', postMandateAction, ['g1', 'close']],
      ['POST', '/shelf', postShelf, []],
      ['GET', '/mandates/g1/draft', getMandateDraft, ['g1']],
      ['POST', '/mandates/g1/draft', postMandateDraft, ['g1']],
      ['POST', '/focus', postFocus, []],
      ['GET', '/chats', getChats, []],
      ['POST', '/chats', postChat, []],
      ['GET', '/chats/0123456789ab', getChat, ['0123456789ab']],
      ['GET', '/chats/0123456789ab/log', getChatLog, ['0123456789ab']],
      ['POST', '/chats/0123456789ab/rename', postChatRename, ['0123456789ab']],
      ['POST', '/chats/0123456789ab/archive', postChatArchive, ['0123456789ab']],
      ['POST', '/chats/0123456789ab/messages', postChatMessage, ['0123456789ab']],
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
      ['GET', '/shelf'],
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
      // Only a 12-hex chat id matches.
      ['GET', '/chats/0123456789AB'],
      ['GET', '/chats/0123456789a'],
      ['GET', '/chats/0123456789abc/log'],
      ['POST', '/chats/..%2f0123456789/messages'],
      ['POST', '/chats/0123456789ab'],
      ['GET', '/chats/0123456789ab/messages'],
      // Only the four mandate actions match, and only as POSTs.
      ['POST', '/mandates/g1/delete'],
      ['GET', '/mandates/g1/edit'],
      ['POST', '/mandates/g1'],
      ['GET', '/mandates/'],
    ],
  );
});
