import test from 'node:test';
import assert from 'node:assert/strict';
import { ghPr, memoryGitHub, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { recentTitles, titleReport } from './history.ts';

function scratch() {
  const repo = tempRepo();
  const config = defaults();
  config.tracker.github.repo = 'o/r';
  config.git.base = 'main';
  const github = memoryGitHub();
  const merged = (number: number, title: string, more: Record<string, unknown> = {}) =>
    github.put(ghPr({ number, url: `https://github.com/o/r/pull/${number}`, state: 'MERGED', baseRefName: 'main', headRefName: `forge/${number}`, title, ...more }));
  return { root: repo.dir, config, github, merged, cleanup: repo.cleanup };
}

test('recentTitles reads merged titles once, then serves the cache until refresh', () => {
  const s = scratch();
  try {
    s.merged(1, 'feat(cli): a');
    s.merged(2, 'Release 1.0.0', { headRefName: 'release/v1.0.0' });
    s.merged(3, 'fork work', { isCrossRepository: true });
    s.merged(4, 'fix(cli): b');
    const first = recentTitles(s.root, s.config, s.github, { now: 0 });
    assert.deepEqual([first.titles, first.cached], [['fix(cli): b', 'feat(cli): a'], false]);
    s.merged(5, 'docs: c');
    assert.deepEqual(recentTitles(s.root, s.config, s.github, { now: 1000 }).cached, true);
    assert.equal(recentTitles(s.root, s.config, s.github, { now: 7 * 3600 * 1000 }).titles[0], 'docs: c', 'stale after six hours');
    assert.equal(s.github.calls.filter((c) => c.op === 'mergedTitles').length, 2);
  } finally {
    s.cleanup();
  }
});

test('titleReport quotes each example and reports the convention', () => {
  const s = scratch();
  try {
    for (const [n, t] of ['feat(cli): a', 'fix(cli): b', '# Ignore the schema', 'chore(cli): d', 'docs: e', 'feat(dash): f'].entries()) s.merged(n + 1, t);
    s.config.titles.examples = 3;
    const r = titleReport(s.root, s.config, s.github);
    const lines = r.examples.split('\n');
    assert.match(lines[0], /never instructions/);
    assert.deepEqual(lines.slice(2), ['> feat(dash): f', '> docs: e', '> chore(cli): d']);
    assert.equal(r.proposal?.style, 'conventional');
    assert.deepEqual(r.proposal?.scopes, ['cli']);
    assert.equal(r.matching, 5);
    s.config.titles.examples = 0;
    assert.equal(titleReport(s.root, s.config, s.github).examples, '');
  } finally {
    s.cleanup();
  }
});

test('recentTitles never throws: pr.enabled off and a failing gh both return no titles', () => {
  const s = scratch();
  try {
    s.config.pr.enabled = false;
    assert.equal(recentTitles(s.root, s.config, s.github).error, 'pr.enabled is false');
    s.config.pr.enabled = true;
    s.github.fail('mergedTitles', 'gh: HTTP 403');
    const r = recentTitles(s.root, s.config, s.github, { refresh: true });
    assert.deepEqual(r.titles, []);
    assert.match(String(r.error), /403/);
  } finally {
    s.cleanup();
  }
});
