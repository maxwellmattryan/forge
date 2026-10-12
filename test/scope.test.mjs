import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { approachPaths, approachSection, inSpec } from '../lib/scope.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const commitAll = (cwd, msg) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};
const write = (dir, rel, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('approachSection: stops at a same-or-higher heading, ignores look-alikes and fenced headings', () => {
  const spec = [
    '# Spec',
    '## Behaviour',
    'see `lib/behaviour.mjs`',
    '### Approach notes',
    'not this one `lib/notes.mjs`',
    '## Approach',
    'touch `lib/a.mjs`',
    '```',
    '## Not a heading',
    '```',
    '### Sub',
    'and `lib/sub.mjs`',
    '## Out of scope',
    '- `lib/out.mjs`',
    '## Tasks',
    '- [ ] edit `lib/task.mjs`',
  ].join('\n');
  const section = approachSection(spec);
  assert.ok(section);
  assert.match(section, /lib\/a\.mjs/);
  assert.match(section, /lib\/sub\.mjs/, 'a lower-level heading stays inside the section');
  assert.doesNotMatch(section, /out\.mjs|task\.mjs|notes\.mjs|behaviour\.mjs/);
  assert.deepEqual(approachPaths(spec).sort(), ['lib/a.mjs', 'lib/sub.mjs']);
  assert.equal(inSpec('lib/out.mjs', approachPaths(spec)), false, 'a path named only under Out of scope is out of spec');
  assert.equal(inSpec('lib/task.mjs', approachPaths(spec)), false, 'a path named only under Tasks is out of spec');
  assert.equal(approachSection('# Spec\n### Approach notes\n`lib/a.mjs`\n'), null);
  assert.deepEqual(approachPaths('# Spec\nno approach here `lib/a.mjs`\n'), []);
});

test('approachPaths: cleans tokens, expands braces, drops non-paths', () => {
  const spec = [
    '## Approach',
    '- **`lib/scope.mjs` (new)** and (`lib/trackers/{local,github}.mjs`), see ./docs/CONFIG.md, lib/x.mjs:12 and lib/y.mjs:3-9',
    '- `lib/z.mjs#L10`; "test/*.test.mjs", [dashboard/]',
    '- skip https://example.com/a.mjs, `--flag`, `<id>`, `$HOME/x`, `forge job scope <id>`, plain words.',
    '- `SKILL.md` and `lib/a.mjs` twice: `lib/a.mjs`',
  ].join('\n');
  const tokens = approachPaths(spec);
  for (const t of ['lib/scope.mjs', 'lib/trackers/local.mjs', 'lib/trackers/github.mjs', 'docs/CONFIG.md', 'lib/x.mjs', 'lib/y.mjs', 'lib/z.mjs', 'test/*.test.mjs', 'dashboard/', 'SKILL.md', 'lib/a.mjs'])
    assert.ok(tokens.includes(t), `missing ${t} in ${JSON.stringify(tokens)}`);
  assert.equal(tokens.filter((t) => t === 'lib/a.mjs').length, 1, 'de-duplicated');
  for (const t of tokens) assert.doesNotMatch(t, /:\/\/|^[-<$]|\s|^\*\*|`/, `unexpected token ${t}`);
  assert.ok(!tokens.includes('words'));
  assert.ok(!tokens.some((t) => t.startsWith('new)')), 'bold closing after a parenthesis is not a glob');
  assert.deepEqual(approachPaths('## Approach\nall of src/** here\n'), ['src/**']);
});

test('inSpec: exact, directory, glob, brace, bare filename', () => {
  const tokens = approachPaths('## Approach\n`lib/exact.mjs`, `docs/`, `lib/trackers`, `test/*.test.mjs`, `src/**/*.ts`, `lib/{a,b}.mjs`, `README.md`, `*.css`\n');
  const yes = ['lib/exact.mjs', 'docs/x.md', 'docs/deep/y.md', 'lib/trackers/github.mjs', 'test/scope.test.mjs', 'src/x.ts', 'src/a/b/c.ts', 'lib/a.mjs', 'lib/b.mjs', 'README.md', 'pkg/README.md', 'dashboard/site.css'];
  const no = ['lib/exact.mjs.bak', 'docsx/y.md', 'lib/trackersx.mjs', 'test/sub/x.test.mjs', 'test/helpers.mjs', 'lib/c.mjs', 'README.markdown', 'src/x.tsx'];
  for (const f of yes) assert.equal(inSpec(f, tokens), true, `${f} should be in spec`);
  for (const f of no) assert.equal(inSpec(f, tokens), false, `${f} should be out of spec`);
  assert.equal(inSpec('lib/x.mjs', ['lib/?.mjs']), true);
  assert.equal(inSpec('lib/xy.mjs', ['lib/?.mjs']), false);
});

test('forge job scope: CLI end to end', () => {
  const repo = tempRepo();
  const wtRoot = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  const fails = (...args) => {
    try {
      execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FORGE_ROOT: repo.dir } });
    } catch (e) {
      assert.notEqual(e.status, 0);
      return String(e.stderr) + String(e.stdout);
    }
    assert.fail(`forge ${args.join(' ')} should have failed`);
  };
  try {
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
    f('init', 'write', '--answers', answers);
    commitAll(repo.dir, 'forge init');

    // AC6: no worktree, then no spec.md.
    const job = f('job', 'new', '--title', 'Scope check');
    const dir = path.join(repo.dir, job.dir);
    assert.match(fails('job', 'scope', job.id), new RegExp(`job ${job.id} has no worktree yet; run: forge worktree create ${job.id}`));
    const wt = f('worktree', 'create', job.id).path;
    assert.match(fails('job', 'scope', job.id), new RegExp(`job ${job.id} has no spec.md`));

    // AC8: paths and usage text.
    assert.equal(f('job', 'paths', job.id).scope, path.join(dir, 'scope.md'));
    assert.match(fails('job', 'bogus'), /\|scope/);
    assert.match(f('--help'), /forge job [^\n]*\|scope/);

    // AC1 and AC7: a commit on the base branch after branching is not counted.
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n## Approach\n- `lib/a.mjs`\n- `docs/`\n## Tasks\n- `lib/b.mjs`\n');
    write(repo.dir, 'base-only.txt');
    commitAll(repo.dir, 'base moves on');
    for (const rel of ['lib/a.mjs', 'docs/x.md', 'lib/b.mjs']) write(wt, rel);
    commitAll(wt, 'job work');
    let r = f('job', 'scope', job.id);
    assert.deepEqual(Object.keys(r), ['id', 'base', 'mergeBase', 'head', 'dirty', 'approach', 'specPaths', 'changed', 'inSpec', 'outOfSpec', 'more', 'file']);
    assert.equal(r.base, 'main');
    assert.match(r.mergeBase, /^[0-9a-f]{40}$/);
    assert.match(r.head, /^[0-9a-f]{40}$/);
    assert.equal(r.dirty, false);
    assert.equal(r.approach, true);
    assert.equal(r.changed, 3);
    assert.equal(r.inSpec, 2);
    assert.deepEqual(r.outOfSpec, ['lib/b.mjs']);
    assert.equal(r.more, 0);
    assert.equal(r.file, path.join(job.dir, 'scope.md'));
    let md = fs.readFileSync(path.join(repo.dir, r.file), 'utf8');
    assert.ok(md.startsWith('SCOPE: 1 of 3'), md);
    assert.doesNotMatch(md, /base-only/);
    assert.doesNotMatch(md, /no Approach section|uncommitted/);

    // AC6: uncommitted files are ignored but reported.
    write(wt, 'scratch/untracked.txt');
    r = f('job', 'scope', job.id);
    assert.equal(r.dirty, true);
    assert.equal(r.changed, 3);
    assert.match(fs.readFileSync(path.join(repo.dir, r.file), 'utf8'), /uncommitted changes; they are not included/);
    fs.rmSync(path.join(wt, 'scratch'), { recursive: true });

    // AC3: no Approach section means everything is out of spec.
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n## Tasks\n- `lib/a.mjs`\n');
    r = f('job', 'scope', job.id);
    assert.equal(r.approach, false);
    assert.equal(r.specPaths, 0);
    assert.deepEqual(r.outOfSpec, ['docs/x.md', 'lib/a.mjs', 'lib/b.mjs']);
    assert.match(fs.readFileSync(path.join(repo.dir, r.file), 'utf8'), /spec\.md has no Approach section/);

    // AC5: more than 20 out-of-spec files are capped in JSON, complete in scope.md.
    for (let i = 0; i < 25; i++) write(wt, `extra/f${String(i).padStart(2, '0')}.txt`);
    commitAll(wt, 'many');
    r = f('job', 'scope', job.id);
    assert.equal(r.changed, 28);
    assert.equal(r.outOfSpec.length, 20);
    assert.equal(r.more, 8);
    md = fs.readFileSync(path.join(repo.dir, r.file), 'utf8');
    assert.ok(md.startsWith('SCOPE: 28 of 28'));
    for (let i = 0; i < 25; i++) assert.ok(md.includes(`\`extra/f${String(i).padStart(2, '0')}.txt\``));
  } finally {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
    fs.rmSync(answers, { force: true });
  }
});
