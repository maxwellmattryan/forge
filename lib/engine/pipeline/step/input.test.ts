import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { folderMaps, loadStepInput } from './input.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, updateJob } from '#core/job/store.ts';
import type { Config } from '#core/types.ts';

/** A scratch directory with `files` written under it (a `null` body makes a directory). */
function tree(files: Record<string, string | null>): { dir: string; cleanup: () => void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-maps-')));
  const dir = path.join(base, 'wt');
  fs.mkdirSync(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (body === null) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
  return { dir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const SPEC = ['# S', '', '## Approach', 'Do it.', '', 'Files:', '| Path | Change |', '|---|---|', '| `lib/x.ts` | edit |', '| `README.md` | edit |', ''].join('\n');

test("loadStepInput reads every role's instruction files and the build's folder maps", (t) => {
  const repo = tempRepo();
  const wt = `${repo.dir}.wt`;
  t.after(() => {
    repo.cleanup();
    fs.rmSync(wt, { recursive: true, force: true });
  });
  for (const [rel, body] of Object.entries({
    'AGENTS.md': '# root\n',
    'docs/DEVELOPING.md': '# dev\n',
    'docs/architecture/t.md': '# t\n',
    'lib/AGENTS.md': '# lib\n\n- Design: [T](../docs/architecture/t.md).\n',
    'lib/x.ts': '',
  })) {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), body);
  }
  const config: Config = defaults();
  config.tracker.kind = 'none';
  config.project.instructions = { default: ['AGENTS.md'], builder: ['AGENTS.md', 'docs/DEVELOPING.md'], approver: ['MISSING.md'] };
  const at = (stage: 'build' | 'spec') => {
    const { id } = jobAt(repo.dir, stage, { config });
    updateJob(repo.dir, id, (j) => void (j.worktree = wt));
    fs.writeFileSync(path.join(jobDir(repo.dir, id), 'spec.md'), SPEC);
    return loadStepInput(repo.dir, config, id);
  };
  const build = at('build');
  for (const f of ['AGENTS.md', 'docs/DEVELOPING.md']) assert.equal(build.present.filter((p) => p === path.join(wt, f)).length, 1, f);
  assert.ok(!build.present.includes(path.join(wt, 'MISSING.md')));
  assert.deepEqual(build.paths.instructions, [path.join(wt, 'AGENTS.md')], 'forge job paths keeps the default list');
  assert.deepEqual(build.folderMaps, { maps: [path.join(wt, 'lib', 'AGENTS.md')], topics: [path.join(wt, 'docs', 'architecture', 't.md')] });
  assert.equal(at('spec').folderMaps, null);
});

test('folderMaps finds the nearest map and its Design topics', (t) => {
  const { dir, cleanup } = tree({
    'AGENTS.md': '# root\n- Design: [R](docs/architecture/r.md)\n',
    'lib/AGENTS.md': '# lib\n\n- Design: [A](../docs/architecture/a.md), [B](../docs/architecture/b.md#sec), [A again](../docs/architecture/a.md), [txt](../docs/x.txt).\n- Design: [late](../docs/architecture/late.md)\n',
    'lib/engine/AGENTS.md': '# engine\n- Design: [C](../../docs/architecture/c.md)\n',
    'lib/engine/pipeline/x.ts': '',
    'lib/plain/AGENTS.md': '# no design bullet\n',
    'docs/architecture/a.md': '',
    'docs/architecture/b.md': '',
    'docs/architecture/c.md': '',
    'docs/architecture/r.md': '',
    'docs/architecture/late.md': '',
    'docs/x.txt': '',
  });
  t.after(cleanup);
  const at = (...rel: string[]) => rel.map((r) => path.join(dir, r));
  assert.deepEqual(folderMaps(dir, ['lib/engine/pipeline/x.ts', 'lib/new/folder/y.ts', 'README.md', 'lib/engine/', 'lib/engine', 'lib/plain/z.ts']), {
    maps: at('lib/engine/AGENTS.md', 'lib/AGENTS.md', 'lib/plain/AGENTS.md'),
    topics: at('docs/architecture/c.md', 'docs/architecture/a.md', 'docs/architecture/b.md'),
  });
  assert.deepEqual(folderMaps(dir, ['README.md', 'new.ts']), { maps: [], topics: [] }, 'a root-level file finds none');
  assert.deepEqual(folderMaps(path.join(dir, 'missing'), ['lib/x.ts']), { maps: [], topics: [] });

  const many: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    many[`m${i}/AGENTS.md`] = `- Design: [t](t${i}.md)\n`;
    many[`m${i}/t${i}.md`] = '';
  }
  const capped = tree(many);
  t.after(capped.cleanup);
  const r = folderMaps(capped.dir, Array.from({ length: 10 }, (_, i) => `m${i}/f.ts`));
  assert.equal(r.maps.length, 8);
  assert.equal(r.topics.length, 8);
  assert.equal(r.more, 4);
  assert.equal(r.maps[0], path.join(capped.dir, 'm0', 'AGENTS.md'));
});

test('folderMaps skips what leaves the worktree', { skip: process.platform === 'win32' && 'symlinks and FIFOs' }, (t) => {
  const { dir, cleanup } = tree({
    'linked/real.md': '- Design: [g](good.md)\n',
    'ok/AGENTS.md': '- Design: [out](../../outside.md), [abs](/etc/hosts.md), [drive](C:/x.md), [miss](missing.md), [sym](link.md), [good](good.md), [dir](sub.md)\n',
    'ok/good.md': '',
    'ok/sub.md': null,
    'fifo/': null,
    'big/t.md': '',
    'hostile/t.md': '',
  });
  t.after(cleanup);
  const outside = path.dirname(dir);
  fs.writeFileSync(path.join(outside, 'outside.md'), '');
  fs.mkdirSync(path.join(outside, 'elsewhere'));
  fs.writeFileSync(path.join(outside, 'elsewhere', 'AGENTS.md'), '- Design: [o](o.md)\n');
  fs.writeFileSync(path.join(outside, 'elsewhere', 'o.md'), '');
  fs.symlinkSync('real.md', path.join(dir, 'linked', 'AGENTS.md'));
  fs.symlinkSync(path.join(outside, 'elsewhere'), path.join(dir, 'out'));
  fs.symlinkSync('good.md', path.join(dir, 'ok', 'link.md'));
  execFileSync('mkfifo', [path.join(dir, 'fifo', 'AGENTS.md')]);
  fs.writeFileSync(path.join(dir, 'big', 'AGENTS.md'), `${'x'.repeat(70 * 1024)}\n- Design: [t](t.md)\n`);

  assert.deepEqual(folderMaps(dir, ['linked/a.ts']), { maps: [], topics: [] }, 'a symlinked AGENTS.md');
  assert.deepEqual(folderMaps(dir, ['out/a.ts']), { maps: [], topics: [] }, 'a map under a symlinked folder that points outside');
  assert.deepEqual(folderMaps(dir, ['fifo/a.ts']), { maps: [], topics: [] }, 'a FIFO');
  assert.deepEqual(folderMaps(dir, ['ok/a.ts']), { maps: [path.join(dir, 'ok', 'AGENTS.md')], topics: [path.join(dir, 'ok', 'good.md')] }, 'only the regular file inside');
  assert.deepEqual(folderMaps(dir, ['big/a.ts']), { maps: [path.join(dir, 'big', 'AGENTS.md')], topics: [] }, 'a Design line past 64 KiB is never read');
  assert.deepEqual(folderMaps(dir, ['../wt/ok/a.ts', '/etc/a.ts']), { maps: [], topics: [] }, 'paths that leave the worktree');

  for (const line of [`- Design: ${'](('.repeat(3400)}`, `- Design: [x](${'a'.repeat(10_000)}`, `- Design: ${'[a](b'.repeat(2000)}`, `- Design: ${'](t.md) '.repeat(1250)}`]) {
    fs.writeFileSync(path.join(dir, 'hostile', 'AGENTS.md'), `${line}\n`);
    const start = performance.now();
    folderMaps(dir, ['hostile/a.ts']);
    const ms = performance.now() - start;
    assert.ok(ms < 100, `a ${line.length}-character Design line took ${ms.toFixed(1)} ms`);
  }
});
