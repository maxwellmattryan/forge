// An `until: released` mandate's plan file and tag: readPlanFile refuses a since selection whose mandate
// isn't a mandate id or whose heads aren't commit ids (anyone who can write .forge/runtime/ can plant
// release.json), lastReleaseTag is null for a repo with no tag or with a tag that isn't a safe ref, and
// otherReleasePlan says what in release.json holds the Office pass back from the mandate's first plan, and
// pickedBumps is the `--bump` a person picked that the mandate's next re-plan keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempRepo } from '../../../test/helpers.ts';
import { logRepoEvent, repoAuditFile } from '#core/job/store.ts';
import { RELEASE_FILE_VERSION } from './plan.ts';
import { readPlanFile, releaseFiles } from './files.ts';
import { lastReleaseTag, otherReleasePlan, pickedBumps } from './mandate.ts';

test('readPlanFile checks a since selection’s mandate', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const files = releaseFiles(r.dir);
  fs.mkdirSync(files.dir, { recursive: true });
  const plant = (selection: Record<string, unknown>) =>
    fs.writeFileSync(files.json, JSON.stringify({ version: RELEASE_FILE_VERSION, hash: 'a'.repeat(64), selection, repos: [], skipped: [], order: [] }));
  const rows: [string, Record<string, unknown>, RegExp | null][] = [
    ['a mandate id', { kind: 'since', tag: 'v1.0.0', mandate: 'm1' }, null],
    ['no mandate (a plain --since plan)', { kind: 'since', tag: 'v1.0.0' }, null],
    ['a mandate id that climbs', { kind: 'since', tag: 'v1.0.0', mandate: '../m1' }, /selection\.mandate "\.\.\/m1" is not a mandate id; re-run forge release plan$/],
    ['the mandate id none', { kind: 'since', tag: 'v1.0.0', mandate: 'none' }, /selection\.mandate "none" is not a mandate id/],
    ['an upper-case id', { kind: 'since', tag: 'v1.0.0', mandate: 'M1' }, /selection\.mandate "M1" is not a mandate id/],
    ['a mandate that is not text', { kind: 'since', tag: 'v1.0.0', mandate: 7 }, /selection\.mandate "7" is not a mandate id/],
    ['a null mandate', { kind: 'since', tag: 'v1.0.0', mandate: null }, /selection\.mandate "null" is not a mandate id/],
    ['heads by label', { kind: 'since', tag: 'v1.0.0', mandate: 'm1', heads: { '(root)': 'a'.repeat(40), api: 'b'.repeat(64) } }, null],
    ['a head that is not a commit id', { kind: 'since', tag: 'v1.0.0', mandate: 'm1', heads: { '(root)': 'HEAD' } }, /selection\.heads is not a map of commit ids; re-run forge release plan$/],
    ['heads that are a list', { kind: 'since', tag: 'v1.0.0', mandate: 'm1', heads: ['a'.repeat(40)] }, /selection\.heads is not a map of commit ids/],
    ['null heads', { kind: 'since', tag: 'v1.0.0', mandate: 'm1', heads: null }, /selection\.heads is not a map of commit ids/],
  ];
  for (const [name, selection, refused] of rows) {
    plant(selection);
    if (refused) assert.throws(() => readPlanFile(files), refused, name);
    else assert.deepEqual(readPlanFile(files)?.selection, selection, name);
  }
});

test('lastReleaseTag is the root’s latest tag reachable from HEAD, or null', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  assert.equal(lastReleaseTag(r.dir), null, 'no tag');
  r.git('tag', 'v0.1.0');
  fs.writeFileSync(`${r.dir}/a.txt`, 'a\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'a');
  assert.equal(lastReleaseTag(r.dir), 'v0.1.0', 'the tag behind HEAD');
  r.git('tag', 'v0.2.0');
  assert.equal(lastReleaseTag(r.dir), 'v0.2.0', 'the tag at HEAD');
  // A tag that would read as an option (or break a path) never reaches git argv: the planner gets nothing.
  assert.equal(lastReleaseTag(r.dir, () => ({ ok: true, stdout: '--upload-pack=x\n' })), null);
  assert.equal(lastReleaseTag(r.dir, () => ({ ok: false, stdout: '' })), null);
});

test('otherReleasePlan: what in release.json the Office pass won’t write over for a mandate', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const files = releaseFiles(r.dir);
  const hash = 'a'.repeat(64);
  const plan = (selection: Record<string, unknown>) => JSON.stringify({ version: RELEASE_FILE_VERSION, hash, selection, repos: [], skipped: [], order: [] });
  const state = (planHash: string, steps: Record<string, unknown>, finishedAt: string | null = null) =>
    JSON.stringify({ version: RELEASE_FILE_VERSION, planHash, startedAt: 'x', updatedAt: 'x', finishedAt, steps });
  const other = plan({ kind: 'job', job: 'j-1' });
  const step = { '(root)/preflight': { status: 'done', at: 'x' } };
  const rows: [string, string | null, string | null, 'none' | 'waiting' | 'running'][] = [
    ['nothing', null, null, 'none'],
    ["the mandate's own plan, not started", plan({ kind: 'since', tag: 'v1.0.0', mandate: 'm1' }), null, 'none'],
    ["the mandate's own plan, started", plan({ kind: 'since', tag: 'v1.0.0', mandate: 'm1' }), state(hash, step), 'none'],
    ["another mandate's plan", plan({ kind: 'since', tag: 'v1.0.0', mandate: 'm2' }), null, 'waiting'],
    ['a plain --since plan', plan({ kind: 'since', tag: 'v1.0.0' }), null, 'waiting'],
    ['another plan, a state of no step', other, state(hash, {}), 'waiting'],
    ["another plan, an older plan's state", other, state('b'.repeat(64), step), 'waiting'],
    ['a release.json it cannot read', '{', null, 'waiting'],
    ["another plan's run in progress", other, state(hash, step), 'running'],
    ['another plan, a state.json it cannot read', other, '{', 'running'],
    ['no plan, a run in progress', null, state(hash, step), 'running'],
    ["another plan's finished run", other, state(hash, step, 'x'), 'none'],
    ['no plan, a finished run', null, state(hash, step, 'x'), 'none'],
  ];
  for (const [name, json, st, want] of rows) {
    fs.rmSync(files.dir, { recursive: true, force: true });
    fs.mkdirSync(files.dir, { recursive: true });
    if (json !== null) fs.writeFileSync(files.json, json);
    if (st !== null) fs.writeFileSync(files.state, st);
    assert.equal(otherReleasePlan(r.dir, 'm1'), want, name);
  }
  // A link is assertNoSymlinks' refusal on the write, not a plan held back.
  fs.rmSync(files.dir, { recursive: true, force: true });
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(`${r.dir}/elsewhere.json`, other);
  fs.symlinkSync(`${r.dir}/elsewhere.json`, files.json);
  assert.equal(otherReleasePlan(r.dir, 'm1'), 'none', 'a symlinked release.json');
});

test('pickedBumps: the bump a person picked, by repo, while the mandate’s plan has not finished', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const files = releaseFiles(r.dir);
  const hash = 'a'.repeat(64);
  const bump = (b: unknown) => ({ from: '1.0.0', to: '1.0.1', bump: b, inferred: 'minor', reasons: [], notes: 'x' });
  const plan = (selection: Record<string, unknown>, repos: unknown[]) => JSON.stringify({ version: RELEASE_FILE_VERSION, hash, selection, repos, skipped: [], order: [] });
  const own = { kind: 'since', tag: 'v1.0.0', mandate: 'm1' };
  const repos = [
    { label: '(root)', bump: bump('patch') },
    { label: 'lib', bump: bump('major') },
    { label: 'api', bump: bump('minor') },
    { label: 'web', bump: null },
  ];
  const finished = JSON.stringify({ version: RELEASE_FILE_VERSION, planHash: hash, startedAt: 'x', updatedAt: 'x', finishedAt: 'x', steps: {} });
  const rows: [string, string | null, string | null, boolean, Record<string, string>][] = [
    ['nothing', null, null, false, {}],
    ["the mandate's own plan: each pick other than the inferred", plan(own, repos), null, false, { '(root)': 'patch', lib: 'major' }],
    ['a bump that is no bump name', plan(own, [{ label: '(root)', bump: bump('huge') }, { label: 'lib', bump: bump('--upload-pack=x') }]), null, false, {}],
    ['its run finished in state.json', plan(own, repos), finished, false, {}],
    ['a finished event for its hash', plan(own, repos), null, true, {}],
    ["another mandate's plan", plan({ ...own, mandate: 'm2' }, repos), null, false, {}],
    ['a plain --since plan', plan({ kind: 'since', tag: 'v1.0.0' }, repos), null, false, {}],
    ['a release.json it cannot read', '{', null, false, {}],
  ];
  for (const [name, json, st, finishedEvent, want] of rows) {
    fs.rmSync(files.dir, { recursive: true, force: true });
    fs.rmSync(repoAuditFile(r.dir), { force: true });
    fs.mkdirSync(files.dir, { recursive: true });
    if (json !== null) fs.writeFileSync(files.json, json);
    if (st !== null) fs.writeFileSync(files.state, st);
    if (finishedEvent) logRepoEvent(r.dir, 'mandate-release-finished', { mandate: 'm1', planHash: hash });
    assert.deepEqual(Object.fromEntries(pickedBumps(r.dir, 'm1')), want, name);
  }
});
