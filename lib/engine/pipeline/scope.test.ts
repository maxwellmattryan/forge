import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from '../../../test/helpers.ts';
import { approachSection, renderDiff, roundDiffText, writeRoundDiff } from './scope.ts';
import type { DiffSection } from './scope.ts';
import { ForgeError } from '#core/errors.ts';

/** A repo whose branch changes `file` after its base commit; the section scope.ts would build for it. */
function section(label: string, prefix: string, file: string): { s: DiffSection; cleanup: () => void } {
  const r = tempRepo();
  const sha = () => r.git('rev-parse', 'HEAD').toString().trim();
  const mergeBase = sha();
  fs.writeFileSync(path.join(r.dir, file), `${label} line\n`);
  r.git('add', '-A');
  r.git('commit', '-qm', `${label} work`);
  return { s: { label, cwd: r.dir, baseRef: 'main', mergeBase, head: sha(), prefix }, cleanup: r.cleanup };
}

test("round diff holds every section's stat, then its diff", () => {
  const root = section('root', '', 'app.txt');
  const lib = section('lib', 'lib/', 'lib.txt');
  try {
    const sections = [root.s, lib.s];
    const head = (s: DiffSection) => `# repo ${s.label} base ${s.baseRef} @ ${s.mergeBase} · HEAD ${s.head}`;
    const text = renderDiff(sections, { stat: true });
    // The stat block ends at its blank line; both sections' stats come before either section's diff.
    const stat = text.slice(0, text.indexOf('\n\n') + 2);
    assert.ok(!stat.includes('diff --git'), text);
    assert.ok(stat.startsWith(`${head(root.s)}\n app.txt | 1 +\n 1 file changed, 1 insertion(+)\n`), text);
    assert.ok(stat.includes(`${head(lib.s)}\n lib.txt | 1 +\n 1 file changed, 1 insertion(+)\n`), text);
    assert.ok(text.includes('diff --git a/lib/lib.txt b/lib/lib.txt\n') && text.includes('+++ b/lib/lib.txt\n@@ -0,0 +1 @@\n+lib line\n'), text);
    assert.ok(text.includes('diff --git a/app.txt b/app.txt\n'), text);

    // scope.diff is what writeScopeDiff wrote before the round diff existed: no stat, the same `# repo` lines.
    const before = sections
      .map((s) => {
        const out = execFileSync(
          'git',
          ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--no-renames', '--ignore-submodules=none', '--text', '-U3', `--src-prefix=a/${s.prefix}`, `--dst-prefix=b/${s.prefix}`, s.mergeBase, s.head, '--'],
          { cwd: s.cwd, encoding: 'utf8' },
        );
        return `${head(s)}\n${out}`;
      })
      .join('');
    assert.equal(renderDiff(sections, { stat: false }), before);
    assert.equal(text, `${stat}${before}`);
    assert.ok(stat.endsWith('\n\n'));

    // A diff git can't render (past run()'s 64 MiB output cap in practice) becomes a note, so RV2 still runs.
    assert.equal(roundDiffText(sections), text);
    const broken = [root.s, { ...lib.s, head: 'f'.repeat(40) }];
    const note = roundDiffText(broken);
    assert.ok(note.startsWith(`${head(root.s)}\n${head(broken[1])}\n\nThe diff was not rendered: `), note);
    assert.ok(note.includes('`forge git diff --stat <merge base> <HEAD>`') && !note.includes('diff --git'), note);
  } finally {
    root.cleanup();
    lib.cleanup();
  }
});

test('approachSection finds a heading with trailing spaces', () => {
  assert.equal(approachSection('# T\n\n## Approach   \nbody\n### Sub\nmore\n## Files\nafter\n'), 'body\n### Sub\nmore');
  assert.equal(approachSection('# Approach\t\nx\n# Next\n'), 'x');
  assert.equal(approachSection('## Approaches\nx\n'), null);
  assert.equal(approachSection(`## Approach${' '.repeat(10_000)}\nx`), 'x');
});

test('writes the round diff without following links', () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-round-diff-')));
  try {
    const round = path.join(top, 'review', 'round-1');
    fs.mkdirSync(round, { recursive: true });
    const target = path.join(top, 'target.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, path.join(round, 'diff.patch'));
    const file = writeRoundDiff(round, 'the diff\n');
    assert.equal(file, path.join(round, 'diff.patch'));
    assert.ok(fs.lstatSync(file).isFile());
    assert.equal(fs.readFileSync(file, 'utf8'), 'the diff\n');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');

    // A round dir swapped for a link to another directory is refused, and nothing is written there.
    const elsewhere = path.join(top, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const linked = path.join(top, 'review', 'round-2');
    fs.symlinkSync(elsewhere, linked);
    assert.throws(() => writeRoundDiff(linked, 'x'), ForgeError);
    assert.deepEqual(fs.readdirSync(elsewhere), []);

    // So is a `review` dir swapped for a link: the round dir in the link's target is real.
    const away = path.join(top, 'away');
    fs.mkdirSync(path.join(away, 'round-1'), { recursive: true });
    fs.mkdirSync(path.join(top, 'job2'));
    fs.symlinkSync(away, path.join(top, 'job2', 'review'));
    assert.throws(() => writeRoundDiff(path.join(top, 'job2', 'review', 'round-1'), 'x'), ForgeError);
    assert.deepEqual(fs.readdirSync(path.join(away, 'round-1')), []);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});
