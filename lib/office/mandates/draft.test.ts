// A goal mandate's milestone draft: the rules a drafter's JSON must keep (each refusal names its
// problem, and a draft with several names them all), and readDraft refusing a newer or broken draft.json.
// Hostile characters are written as escapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { DRAFT_SCHEMA_VERSION } from '#core/versions/draft.ts';
import { draftFile, draftProblems, readDraft, trackerRefCheck } from './draft.ts';

const config = () => {
  const c = defaults();
  c.tracker.kind = 'github';
  c.tracker.github.repo = 'acme/web';
  return c;
};

const issue = (key: string, wave: number, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Do ${key}`,
  why: 'Because the goal needs it.\n\tWith a tab.',
  whatToDo: 'Change the thing.',
  done: 'The thing is changed.',
  stat: 'quality.firstPassReviewRate',
  wave,
  dependsOn: [],
  files: [`lib/${key}/`],
  existing: null,
  ...extra,
});

/** Two waves; one issue reuses open issue 12, one amends acme/web#13. */
const valid = () => ({
  milestone: { title: 'Faster reviews', exitCriteria: ['First-pass review rate over 0.6'] },
  issues: [
    issue('a', 1, { existing: { ref: '12', action: 'reuse' } }),
    issue('b', 1, { files: ['lib/b/x.ts', 'docs/b.md'] }),
    issue('c', 2, { dependsOn: ['a', 'b'], files: ['lib/a/'], existing: { ref: 'acme/web#13', action: 'amend' } }),
  ],
});

test('draft rules', () => {
  const root = '/nonexistent';
  const check = trackerRefCheck(root, config());
  const ok = draftProblems(valid(), check);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(
    ok.draft!.issues.map((i) => i.existing),
    [{ ref: 'acme/web#12', action: 'reuse' }, null, { ref: 'acme/web#13', action: 'amend' }],
    'refs are stored in their qualified form',
  );
  type Edit = (d: any) => void;
  const rows: [string, Edit, RegExp][] = [
    ['an unknown top-level key', (d) => (d.extra = 1), /^the draft: 1 unknown key$/],
    ['an unknown issue key', (d) => (d.issues[0].priority = 'high'), /^issues\[0\]: 1 unknown key$/],
    ['a missing why', (d) => delete d.issues[1].why, /^issues\[1\]: no why$/],
    ['0 issues', (d) => (d.issues = []), /^issues must be a list of 1-30 issues \(got 0\)$/],
    ['31 issues', (d) => (d.issues = Array.from({ length: 31 }, (_, i) => issue(`k${i}`, 1, { files: [`f${i}`] }))), /^issues must be a list of 1-30 issues \(got 31\)$/],
    ['a duplicate key', (d) => (d.issues[1].key = 'a'), /^issues\[1\]\.key repeats issues\[0\]\.key$/],
    ['an unknown dependency', (d) => (d.issues[2].dependsOn = ['zz']), /^issues\[2\]\.dependsOn\[0\] names no issue in the draft$/],
    ['a dependency on itself', (d) => (d.issues[2].dependsOn = ['c']), /^issues\[2\]\.dependsOn\[0\] is the issue itself$/],
    ['a dependency in the same wave', (d) => (d.issues[1].dependsOn = ['a']), /^issues\[1\]\.dependsOn\[0\] is issues\[0\] in wave 1, not before wave 1: a dependency must sit in an earlier wave$/],
    ['a dependency in a later wave', (d) => (d.issues[0].dependsOn = ['c']), /^issues\[0\]\.dependsOn\[0\] is issues\[2\] in wave 2, not before wave 1: a dependency must sit in an earlier wave$/],
    ['waves [1, 3]', (d) => (d.issues[2].wave = 3), /^waves must run 1 to 3 with no gap \(no issue in wave 2\)$/],
    ['equal files in one wave', (d) => (d.issues[1].files = ['lib/a/']), /^issues\[0\] and issues\[1\] in wave 1 share files\[0\]: issues in one wave must not share files$/],
    ['prefix files in one wave', (d) => (d.issues[1].files = ['lib/a/b.ts']), /^issues\[0\] and issues\[1\] in wave 1 share files\[0\]/],
    ['a file starting /', (d) => (d.issues[0].files = ['/etc/passwd']), /^issues\[0\]\.files\[0\] must be repo-relative, not start with \/ or -$/],
    ['a file starting -', (d) => (d.issues[0].files = ['ok.ts', '-rf']), /^issues\[0\]\.files\[1\] must be repo-relative/],
    ['a file with a .. segment', (d) => (d.issues[0].files = ['lib/../../x']), /^issues\[0\]\.files\[0\] may hold no \.\. segment and no backslash$/],
    ['a title with U+200B', (d) => (d.issues[0].title = `Do${String.fromCharCode(0x200b)}a`), /^issues\[0\]\.title holds hidden characters or HTML comments$/],
    ['why holding U+0007', (d) => (d.issues[0].why = 'ring\u0007'), /^issues\[0\]\.why may hold no control character but line feed and tab$/],
    ['an invalid existing ref', (d) => (d.issues[1].existing = { ref: '--web', action: 'reuse' }), /^issues\[1\]\.existing\.ref is not a valid issue ref for this tracker$/],
    ['the same existing ref twice', (d) => (d.issues[1].existing = { ref: '#12', action: 'amend' }), /^issues\[0\] and issues\[1\] name the same existing issue$/],
    ['11 exit criteria', (d) => (d.milestone.exitCriteria = Array.from({ length: 11 }, (_, i) => `c${i}`)), /^milestone\.exitCriteria must be a list of 1-10 entries$/],
  ];
  for (const [name, edit, want] of rows) {
    const d = valid();
    edit(d);
    const r = draftProblems(d, check);
    assert.equal(r.draft, null, name);
    assert.ok(r.problems.some((p) => want.test(p)), `${name}: ${JSON.stringify(r.problems)}`);
  }
  const apart = valid();
  apart.issues[2].files = ['lib/b/x.ts'];
  assert.deepEqual(draftProblems(apart, check).problems, [], 'equal files in different waves pass');

  const three = valid() as any;
  three.issues[0].why = '';
  three.issues[1].wave = 0;
  three.extra = true;
  const many = draftProblems(three, check).problems;
  assert.equal(many.length, 3, JSON.stringify(many));
});

test('refusals name positions, never drafter text', () => {
  const check = trackerRefCheck('/nonexistent', config());
  const d = valid() as any;
  d.ZZINJECT = 1;
  d.issues[0].key = 'ZZINJECT key';
  d.issues[0].files = ['/ZZINJECT', 'lib/c/ZZINJECT'];
  d.issues[1].dependsOn = ['ZZINJECT'];
  d.issues[1].existing = { ref: '--ZZINJECT', action: 'reuse' };
  d.issues[1].files = ['lib/c/ZZINJECT', 'lib/a/'];
  d.issues[1][`ZZINJECT-${'x'.repeat(10000)}`] = true;
  const { problems, draft } = draftProblems(d, check);
  assert.equal(draft, null);
  assert.ok(problems.length >= 6, JSON.stringify(problems));
  for (const p of problems) assert.ok(!p.includes('ZZINJECT') && p.length < 300, p);
  for (const want of [/^the draft: 1 unknown key$/, /^issues\[0\]\.key /, /^issues\[0\]\.files\[0\] /, /^issues\[1\]\.dependsOn\[0\] /, /^issues\[1\]\.existing\.ref /, /^issues\[1\]: 1 unknown key$/, /^issues\[0\] and issues\[1\] in wave 1 share files\[1\]/])
    assert.ok(problems.some((p) => want.test(p)), `${want}: ${JSON.stringify(problems)}`);
});

test('readDraft refuses a newer or broken file', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const id = 'g1';
  const file = draftFile(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(readDraft(root, id), null, 'no file reads as none');
  const good = { schemaVersion: DRAFT_SCHEMA_VERSION, mandate: id, request: '1761000000000-abc', recordedAt: '2026-10-25T00:00:00.000Z', ...draftProblems(valid(), trackerRefCheck(root, config())).draft };
  fs.writeFileSync(file, JSON.stringify(good));
  const read = readDraft(root, id);
  assert.ok(read && !('problem' in read), JSON.stringify(read));
  assert.equal(read.issues.length, 3);
  assert.equal(read.digest, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'the digest is the SHA-256 of the bytes read');

  const rows: [string, () => void, RegExp][] = [
    ['a newer schemaVersion', () => fs.writeFileSync(file, JSON.stringify({ ...good, schemaVersion: DRAFT_SCHEMA_VERSION + 1 })), /newer Forge/],
    ['another mandate', () => fs.writeFileSync(file, JSON.stringify({ ...good, mandate: 'other' })), /differs from g1/],
    ['an extra header key', () => fs.writeFileSync(file, JSON.stringify({ ...good, filedAt: 'x' })), /^the draft: 1 unknown key$/],
    ['a ref not in stored form', () => fs.writeFileSync(file, JSON.stringify({ ...good, issues: good.issues!.map((i, n) => (n ? i : { ...i, existing: { ref: '#12', action: 'reuse' } })) })), /^issues\[0\]\.existing\.ref is not a valid issue ref/],
    ['not JSON', () => fs.writeFileSync(file, '{'), /^not JSON$/],
    [
      'a symlink',
      () => {
        fs.rmSync(file);
        fs.writeFileSync(path.join(root, 'elsewhere.json'), JSON.stringify(good));
        fs.symlinkSync(path.join(root, 'elsewhere.json'), file);
      },
      /symlink/,
    ],
  ];
  for (const [name, plant, want] of rows) {
    plant();
    const r = readDraft(root, id);
    assert.ok(r && 'problem' in r && want.test(r.problem), `${name}: ${JSON.stringify(r)}`);
  }
});
