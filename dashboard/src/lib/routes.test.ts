// The hash router: which page a hash names and what it rewrites to, the `?project=` entry redirect, and where the
// switcher goes. Crafted project segments never become a route's project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryRedirect, parseRoute, routeProject, switchHash, type ParsedRoute } from './routes.ts';

const overview = { scope: 'global', view: 'overview' } as const;
const toOverview: ParsedRoute = { route: overview, replace: '#/overview', openNeeds: false };
const at = (project: string, view: string, replace: string | null = null, openNeeds = false) => ({ route: { scope: 'project', project, view }, replace, openNeeds });

test('parseRoute', () => {
  const rows: [string, string, string | null, unknown][] = [
    // Global pages, with no project selected and no rewrite.
    ['an empty hash is the Overview', '', null, { route: overview, replace: null, openNeeds: false }],
    ['# is the Overview', '#', null, { route: overview, replace: null, openNeeds: false }],
    ['#/ is the Overview', '#/', 'web', { route: overview, replace: null, openNeeds: false }],
    ['#/overview', '#/overview', null, { route: overview, replace: null, openNeeds: false }],
    ['#/machine', '#/machine', null, { route: { scope: 'global', view: 'machine' }, replace: null, openNeeds: false }],
    // Project pages.
    ['a project view', '#/p/web/issues', null, at('web', 'issues')],
    ['an old backlog link goes to Issues', '#/p/web/backlog', null, at('web', 'issues', '#/p/web/issues')],
    ['an inherited property is not a view', '#/p/web/constructor', null, at('web', 'pipeline', '#/p/web/pipeline')],
    ['every project view', '#/p/a.b-c_d/evals', null, at('a.b-c_d', 'evals')],
    ['no view', '#/p/web', null, at('web', 'pipeline', '#/p/web/pipeline')],
    ['an empty view', '#/p/web/', null, at('web', 'pipeline', '#/p/web/pipeline')],
    ['an unknown view', '#/p/web/nope', null, at('web', 'pipeline', '#/p/web/pipeline')],
    ['a view with more segments', '#/p/web/backlog/x', null, at('web', 'pipeline', '#/p/web/pipeline')],
    ['inbox opens Needs you on the Pipeline', '#/p/web/inbox', null, at('web', 'pipeline', '#/p/web/pipeline', true)],
    // Crafted project segments: checked raw, never decoded.
    ['an uppercase name', '#/p/Web/pipeline', 'web', toOverview],
    ['a traversal', '#/p/../state', 'web', toOverview],
    ['an encoded slash', '#/p/a%2Fb/pipeline', 'web', toOverview],
    ['an encoded traversal', '#/p/%2E%2E/pipeline', 'web', toOverview],
    ['65 characters', `#/p/${'x'.repeat(65)}/pipeline`, null, toOverview],
    ['64 characters is a name', `#/p/${'x'.repeat(64)}/agents`, null, at('x'.repeat(64), 'agents')],
    ['an empty name', '#/p//pipeline', null, toOverview],
    ['no name at all', '#/p/', null, toOverview],
    // Anything else.
    ['an unknown hash', '#/nope', 'web', toOverview],
    ['a global page with more segments', '#/overview/x', null, toOverview],
    ['text', '#hello world', null, toOverview],
    // Old routes go to the last project, or the Overview.
    ['an old view with a last project', '#/backlog', 'web', at('web', 'issues', '#/p/web/issues')],
    ['old #backlog without the slash', '#backlog', 'web', at('web', 'issues', '#/p/web/issues')],
    ['old #/backlog with no last project', '#/backlog', null, toOverview],
    ['an inherited property is not an old view', '#/constructor', 'web', toOverview],
    ['__proto__ is not an old view', '#/__proto__', 'web', toOverview],
    ['every old view', '#/analytics', 'api', at('api', 'analytics', '#/p/api/analytics')],
    ['an old view without the slash', '#agents', 'web', at('web', 'agents', '#/p/web/agents')],
    ['old #/inbox opens Needs you', '#/inbox', 'web', at('web', 'pipeline', '#/p/web/pipeline', true)],
    ['an old view with no last project', '#/pipeline', null, toOverview],
    ['an old view with an invalid last project', '#/evals', '../x', toOverview],
    ['old #/inbox with no last project', '#/inbox', '', toOverview],
  ];
  for (const [name, hash, last, want] of rows) assert.deepEqual(parseRoute(hash, last), want, name);
});

test('entryRedirect', () => {
  const rows: [string, string, string | null][] = [
    ['?project=web', '', '/#/p/web/pipeline'],
    ['?project=web', '#/', '/#/p/web/pipeline'],
    ['?project=web', '#/backlog', '/#/p/web/issues'],
    ['?project=web', '#/issues', '/#/p/web/issues'],
    // An inherited property is not a view.
    ['?project=web', '#/toString', '/#/p/web/pipeline'],
    ['?project=web', '#/inbox', '/#/p/web/inbox'],
    ['?project=web', '#/p/api/agents', '/#/p/api/agents'],
    ['?project=web', '#/machine', '/#/machine'],
    ['?project=web', '#/overview', '/#/overview'],
    ['?project=web', '#/nope', '/#/p/web/pipeline'],
    ['?project=web&x=1', '#/evals', '/#/p/web/evals'],
    // A bad name drops the query and keeps the hash.
    ['?project=Bad', '#/evals', '/#/evals'],
    ['?project=..', '', '/'],
    ['?project=a%2Fb', '#/pipeline', '/#/pipeline'],
    // No project: nothing to rewrite.
    ['', '#/backlog', null],
    ['?x=1', '', null],
    ['?project=', '#/pipeline', null],
  ];
  for (const [search, hash, want] of rows) assert.equal(entryRedirect(search, hash), want, `${search} ${hash}`);
});

test('switchHash', () => {
  assert.equal(switchHash('api', { scope: 'project', project: 'web', view: 'issues' }), '#/p/api/issues', 'the same view');
  assert.equal(switchHash('api', { scope: 'project', project: 'web', view: 'pipeline' }), '#/p/api/pipeline');
  assert.equal(switchHash('api', overview), '#/p/api/pipeline', 'the Pipeline from a global page');
  assert.equal(switchHash('api', { scope: 'global', view: 'machine' }), '#/p/api/pipeline');
  assert.equal(routeProject({ scope: 'project', project: 'web', view: 'evals' }), 'web');
  assert.equal(routeProject(overview), null);
});
