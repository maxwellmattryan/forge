// An `until: released` mandate's plan file and tag: readPlanFile refuses a since selection whose mandate
// isn't a mandate id (anyone who can write .forge/runtime/ can plant release.json), and lastReleaseTag
// is null for a repo with no tag or with a tag that isn't a safe ref.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempRepo } from '../../../test/helpers.ts';
import { RELEASE_FILE_VERSION } from './plan.ts';
import { readPlanFile, releaseFiles } from './files.ts';
import { lastReleaseTag } from './mandate.ts';

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
