// Cross-repo review: the combined scope and diff, member panels with qualified lenses, briefs and
// verdict heads for a job with a reviewed member repo. Scratch repos only (job-repos-fixture.ts);
// no gh and no real GitHub repo.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  return p;
}

const SPEC = ['# Two repos', '', 'Suggested reviewers: code', '', '## Approach', '- `lib/lib.txt` and `app.txt`', ''].join('\n');

/** A job with member lib (verify-only when asked), its worktrees, root and lib commits, and a spec. */
async function setup(p: TwoRepo, opts: { verifyOnly?: boolean; noMember?: boolean; libFiles?: Record<string, string>; spec?: string } = {}) {
  const j = await p.f('job', 'new', '--title', `review job ${Math.random().toString(36).slice(2, 8)}`);
  if (!opts.noMember) await p.f('job', 'repo', 'add', ...(opts.verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  await p.f('worktree', 'create', j.id);
  const rootWt = path.join(p.parent, 'app.worktrees', j.id);
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  p.commit(rootWt, { 'app.txt': 'app\n', 'zz.txt': 'z\n' }, 'feat: app');
  if (!opts.noMember && !opts.verifyOnly) p.commit(libWt, opts.libFiles ?? { 'lib.txt': 'lib\n', 'other.txt': 'other\n' }, 'feat: lib');
  const dir = path.join(p.root, '.forge', 'jobs', j.id);
  fs.writeFileSync(path.join(dir, 'spec.md'), opts.spec ?? SPEC);
  await p.f('job', 'round', j.id);
  return { id: j.id as string, rootWt, libWt, dir };
}

const head = (p: TwoRepo, cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();

describe('cross-repo review: scope', { concurrency: 4 }, () => {
  test('scope combines every reviewed repo with prefixed paths and heads', async () => {
    const p = await project();
    const j = await setup(p);
    const s = await p.f('job', 'scope', j.id);
    assert.equal(s.changed, 4);
    assert.equal(s.inSpec, 2);
    assert.deepEqual(s.outOfSpec, ['zz.txt', 'lib/other.txt']);
    assert.equal(s.repos.length, 1);
    const libHead = head(p, j.libWt);
    const libBase = p.git(j.libWt, 'merge-base', 'origin/main', 'HEAD').trim();
    assert.deepEqual(s.repos[0], { repo: 'lib', base: 'origin/main', mergeBase: libBase, head: libHead, dirty: false, changed: 2 });
    assert.deepEqual(s.heads, { lib: libHead });
    assert.equal(s.head, head(p, j.rootWt));
    assert.equal(s.diff, 'scope.diff');
    const md = fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8');
    assert.match(md, /^SCOPE: 2 of 4 changed files outside spec Approach/);
    assert.ok(md.includes(`\nRepo lib: base origin/main @ ${libBase.slice(0, 12)} · HEAD ${libHead.slice(0, 12)}\n`), md);
    assert.ok(md.indexOf('Repo lib:') > md.indexOf('Base '), 'the Repo line follows the root Base line');
    assert.ok(md.includes('## Out of spec (2)\n- `zz.txt`\n- `lib/other.txt`\n'), md);
    assert.ok(md.includes('## In spec (2)\n- `app.txt`\n- `lib/lib.txt`\n'), md);
    assert.doesNotMatch(md, /has uncommitted changes/);
    const ev = p.events(j.id).filter((e) => e.type === 'scope').at(-1);
    assert.deepEqual(ev.heads, { lib: libHead });
    // Uncommitted member changes are named, not included.
    fs.writeFileSync(path.join(j.libWt, 'wip.txt'), 'wip\n');
    const dirty = await p.f('job', 'scope', j.id);
    assert.equal(dirty.repos[0].dirty, true);
    assert.equal(dirty.changed, 4);
    assert.match(fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8'), /\n> Repo lib has uncommitted changes; they are not included\.\n/);
  });

  test('scope.diff pins prefixes and ignores worktree diff config', async () => {
    const p = await project();
    const j = await setup(p);
    const plain = async () => {
      await p.f('job', 'scope', j.id);
      return fs.readFileSync(path.join(j.dir, 'scope.diff'), 'utf8');
    };
    const before = await plain();
    const rootSection = before.indexOf('# repo root base origin/main @ ');
    const libSection = before.indexOf('# repo lib base origin/main @ ');
    assert.equal(rootSection, 0, before);
    assert.ok(libSection > rootSection, before);
    const root = before.slice(0, libSection);
    const lib = before.slice(libSection);
    assert.match(root, /^diff --git a\/app\.txt b\/app\.txt$/m);
    assert.match(lib, /^diff --git a\/lib\/lib\.txt b\/lib\/lib\.txt$/m);
    assert.match(lib, /^\+\+\+ b\/lib\/lib\.txt$/m);
    assert.ok(lib.includes(`· HEAD ${head(p, j.libWt)}\n`), lib);
    // The builder can write the member worktree's git config; none of it reshapes the diff.
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.external', 'echo EXTERNAL-DIFF'], ['color.diff', 'always']]) p.git(j.libWt, 'config', k, v);
    p.git(j.rootWt, 'config', 'diff.noprefix', 'true');
    const after = await plain();
    assert.equal(after, before);
    assert.doesNotMatch(after, /EXTERNAL-DIFF/);
  });

  test('verify-only members are not reviewed', async () => {
    const p = await project();
    const j = await setup(p, { verifyOnly: true });
    // A stale combined diff from an earlier multi-repo run is removed.
    fs.writeFileSync(path.join(j.dir, 'scope.diff'), 'stale\n');
    const s = await p.f('job', 'scope', j.id);
    for (const k of ['repos', 'heads', 'diff']) assert.ok(!(k in s), `no ${k} key`);
    assert.equal(s.changed, 2);
    assert.ok(!fs.existsSync(path.join(j.dir, 'scope.diff')));
    const md = fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8');
    assert.doesNotMatch(md, /Repo lib/);
    assert.ok(md.includes('## In spec (1)\n- `app.txt`\n## Paths'), md);
    assert.ok(!('heads' in p.events(j.id).filter((e) => e.type === 'scope').at(-1)));
  });

  test('a member worktree that is not Forge\'s fails the scope', async () => {
    const p = await project();
    const j = await setup(p);
    fs.rmSync(j.libWt, { recursive: true, force: true });
    const r = await p.raw(['job', 'scope', j.id]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr + r.stdout, /has no worktree for repo lib/);
  });
});
