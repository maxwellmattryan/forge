// Downstream verification (issue #186): config `downstream`, its migration, and the pure candidate
// list (lib/downstream.ts). Pure data, no sh.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { changedRepos, downstreamMembers, downstreamRepos } from '../lib/downstream.ts';
import { migrate } from '../lib/commands/init.ts';
import { CONFIG_SCHEMA_VERSION, normalizeJob } from '../lib/schema.ts';
import type { Config, Job, JobEvent, JobRepo } from '../lib/types.ts';
import * as yaml from '../lib/yaml.ts';

const DEFAULT = { enabled: true, max: 5, skip: [] };
const REPOS = ['app-a', 'app-b', 'app-c', 'lib2'].map((name) => ({ name, remote: `https://example.com/${name}.git`, defaultBranch: 'main' }));
const cmake = { ecosystem: 'cmake', name: 'core' };

/** Root `core`; app-a and app-b consume it with a link; app-c consumes it with none; lib2 is a member library app-c also uses. */
function config(edit: (c: Config) => void = () => {}): Config {
  const c = defaults();
  c.repos = structuredClone(REPOS);
  c.verify = ['build', ['lint', 'test']];
  c.components = [
    { name: 'core', path: 'core', kind: 'library' },
    { name: 'a', repo: 'app-a', path: '.', kind: 'app', commands: { test: 'run-a' }, dependsOn: [{ component: 'core', type: 'build', link: cmake }] },
    { name: 'b', repo: 'app-b', path: '.', kind: 'app', commands: { lint: 'lint-b' }, dependsOn: [{ component: 'core', type: 'build', link: cmake }] },
    { name: 'c', repo: 'app-c', path: '.', kind: 'app', commands: { test: 'run-c' }, dependsOn: [{ component: 'core', type: 'build' }, { component: 'l2', type: 'build', link: { ecosystem: 'cmake', name: 'l2' } }] },
    { name: 'l2', repo: 'lib2', path: '.', kind: 'library', commands: { test: 'run-l2' } },
  ] as Config['components'];
  edit(c);
  return c;
}

const member = (repo: string, verifyOnly: boolean): JobRepo => ({ repo, worktree: null, branch: verifyOnly ? null : 'forge/j', base: 'main', pr: null, verifyOnly, interim: null });
function job(...members: JobRepo[]): Job {
  const j = normalizeJob({ id: 'j', branch: 'forge/j', base: 'main' }) as Job;
  j.repos = [j.repos[0], ...members];
  return j;
}
let n = 0;
const ev = (type: string, data: Record<string, unknown>): JobEvent => ({ v: 2, ts: `2026-10-01T00:00:${String(n++ % 60).padStart(2, '0')}.000Z`, type, ...data });

describe('downstream verification: config', { concurrency: 4 }, () => {
  test('downstream config: defaults and validation', () => {
    assert.deepEqual(defaults().downstream, DEFAULT);
    const problems = (downstream: unknown, repos: unknown = REPOS) =>
      validateConfig({ ...defaults(), repos, downstream }, process.cwd()).filter((p) => p.startsWith('downstream'));
    assert.deepEqual(problems(DEFAULT), []);
    assert.deepEqual(problems({ enabled: false, max: 0, skip: ['app-a'] }), []);
    assert.deepEqual(problems({ enabled: true, max: 50, skip: [] }), []);
    assert.deepEqual(problems('yes'), ['downstream must be a map (got "yes")']);
    assert.deepEqual(problems(['x']), ['downstream must be a map (got ["x"])']);
    assert.deepEqual(problems({ ...DEFAULT, enabled: 'true' }), ['downstream.enabled must be true or false (got "true")']);
    for (const max of [-1, 51, 1.5, '3'])
      assert.deepEqual(problems({ ...DEFAULT, max }), [`downstream.max must be an integer from 0 to 50 (got ${JSON.stringify(max)})`], String(max));
    assert.deepEqual(problems({ ...DEFAULT, skip: 'app-a' }), ['downstream.skip must be a list of repos names (got "app-a")']);
    assert.deepEqual(problems({ ...DEFAULT, skip: ['app-a', 3] }), ['downstream.skip must be a list of repos names (got ["app-a",3])']);
    assert.deepEqual(problems({ ...DEFAULT, skip: ['app-a', 'nope'] }), ['downstream.skip names unknown repo "nope"']);
  });

  test('forge migrate writes the downstream default into a v13 config', () => {
    const r = tempRepo();
    try {
      const file = path.join(r.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, 'schemaVersion: 13\ntracker:\n  kind: none\n'); // old-version fixture
      assert.equal(loadConfig(r.dir).migratedFrom, 13);
      migrate(r.dir);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, new RegExp(`^schemaVersion: ${CONFIG_SCHEMA_VERSION}$`, 'm'));
      assert.deepEqual(yaml.parse(text).downstream, DEFAULT);
    } finally {
      r.cleanup();
    }
  });
});

describe('downstream verification: candidates', { concurrency: 4 }, () => {
  test('downstreamRepos: consumers, order, skips and cap', () => {
    // Root changed only: app-a and app-b in repos order; app-c has no link to the root, lib2 consumes nothing.
    assert.deepEqual(downstreamRepos(config(), job(), [], 'core-repo'), {
      add: ['app-a', 'app-b'],
      skipped: [{ repo: 'app-c', reason: 'no link on its dependsOn edge to core-repo, so it would test the released library' }],
    });
    // Disabled: nothing at all.
    assert.deepEqual(downstreamRepos(config((c) => (c.downstream.enabled = false)), job(), []), { add: [], skipped: [] });
    // Already on the job (edited or verify-only): neither added nor listed.
    assert.deepEqual(downstreamRepos(config(), job(member('app-a', true)), []).add, ['app-b']);
    assert.deepEqual(downstreamRepos(config(), job(member('app-b', false)), []).add, ['app-a']);
    // An edited member is a changed repo: app-c consumes lib2 through a link, so it is added.
    const edited = downstreamRepos(config(), job(member('lib2', false)), []);
    assert.deepEqual(edited.add, ['app-a', 'app-b', 'app-c']);
    // A verify-only member is never a changed repo: no transitive discovery through it.
    assert.deepEqual(downstreamRepos(config(), job(member('lib2', true)), [], 'core-repo').add, ['app-a', 'app-b']);
    // Rule 2: skip list.
    assert.deepEqual(downstreamRepos(config((c) => (c.downstream.skip = ['app-a'])), job(), []).skipped[0], { repo: 'app-a', reason: 'listed in downstream.skip' });
    // Rule 3: removed by a human after its latest add, but not once added again.
    const removed = [ev('job-repo-added', { repo: 'app-b', verifyOnly: true, downstream: true }), ev('job-repo-removed', { repo: 'app-b' })];
    assert.deepEqual(downstreamRepos(config(), job(), removed).skipped[0], { repo: 'app-b', reason: 'removed from the job by a human' });
    assert.deepEqual(downstreamRepos(config(), job(), [...removed, ev('job-repo-added', { repo: 'app-b', verifyOnly: true })]).add, ['app-a', 'app-b']);
    // Rule 4 names the changed repo the edge points at.
    const memberOnly = config((c) => {
      const comps = c.components as any[];
      comps.find((x) => x.name === 'c').dependsOn = [{ component: 'l2', type: 'build' }];
    });
    assert.deepEqual(downstreamRepos(memberOnly, job(member('lib2', false)), []).skipped, [
      { repo: 'app-c', reason: 'no link on its dependsOn edge to lib2, so it would test the released library' },
    ]);
    // Rule 5: commands outside the verify steps do not count.
    const noVerify = config((c) => ((c.components as any[]).find((x) => x.name === 'b').commands = { dev: 'serve', test: '  ' }));
    assert.deepEqual(downstreamRepos(noVerify, job(), []).skipped.find((s) => s.repo === 'app-b'), { repo: 'app-b', reason: 'defines no verify step command' });
    // Rule 6: the cap counts existing downstream members.
    const one = config((c) => (c.downstream.max = 1));
    assert.deepEqual(downstreamRepos(one, job(), []), {
      add: ['app-a'],
      skipped: [
        { repo: 'app-b', reason: 'over downstream.max (1)' },
        { repo: 'app-c', reason: 'no link on its dependsOn edge to root, so it would test the released library' },
      ],
    });
    const already = job(member('app-a', true));
    const addedA = [ev('job-repo-added', { repo: 'app-a', verifyOnly: true, downstream: true })];
    assert.deepEqual(downstreamRepos(one, already, addedA).skipped[0], { repo: 'app-b', reason: 'over downstream.max (1)' });
    // A verify-only member a human added is not a downstream one, so it does not count.
    assert.deepEqual(downstreamRepos(one, already, [ev('job-repo-added', { repo: 'app-a', verifyOnly: true })]).add, ['app-b']);
    assert.deepEqual(downstreamRepos(config((c) => (c.downstream.max = 0)), job(), []).add, []);
    // The first rule that applies wins: skip before removed before link.
    assert.equal(downstreamRepos(config((c) => (c.downstream.skip = ['app-b'])), job(), removed).skipped[0].reason, 'listed in downstream.skip');
    // Single-repo projects have none, and bad names in config are ignored.
    assert.deepEqual(downstreamRepos(defaults(), job(), []), { add: [], skipped: [] });
    assert.deepEqual(downstreamRepos(config((c) => c.repos.unshift({ name: '-bad', remote: 'x', defaultBranch: 'main' })), job(), []).add, ['app-a', 'app-b']);
  });

  test('downstreamMembers: verify-only members whose latest add says downstream', () => {
    const j = job(member('app-a', true), member('app-b', true), member('lib2', false));
    const events = [
      ev('job-repo-added', { repo: 'app-a', verifyOnly: true, downstream: true }),
      ev('job-repo-added', { repo: 'app-b', verifyOnly: true, downstream: true }),
      ev('job-repo-removed', { repo: 'app-b' }),
      ev('job-repo-added', { repo: 'app-b', verifyOnly: true }),
      ev('job-repo-added', { repo: 'lib2', verifyOnly: true, downstream: true }),
    ];
    assert.deepEqual([...downstreamMembers(j, events)], ['app-a']);
    assert.deepEqual([...downstreamMembers(job(), events)], []);
  });

  test('a hand-edited, unpromoted downstream member is not a changed repo', () => {
    // lib2 joined downstream and job.json was edited to verifyOnly: false with no promotion: its consumer app-c must not be pulled in.
    const edited = job(member('lib2', false));
    const joined = [ev('job-repo-added', { repo: 'lib2', verifyOnly: true, downstream: true })];
    assert.deepEqual([...changedRepos(edited, joined)], [null]);
    assert.deepEqual(downstreamRepos(config(), edited, joined, 'core-repo').add, ['app-a', 'app-b']);
    // Promoted after it joined: a changed repo, so its consumer is discovered.
    const promoted = [...joined, ev('job-repo-promoted', { repo: 'lib2' })];
    assert.deepEqual([...changedRepos(edited, promoted)], [null, 'lib2']);
    assert.deepEqual(downstreamRepos(config(), edited, promoted).add, ['app-a', 'app-b', 'app-c']);
    // Added edited by a human: a changed repo as before.
    assert.deepEqual([...changedRepos(edited, [ev('job-repo-added', { repo: 'lib2', verifyOnly: false })])], [null, 'lib2']);
  });
});
