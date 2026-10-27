// What `forge run <job> <command> --changed` selects (docs/CONFIG.md "Related tests"): selectTests's
// resolution over a fixed file list, and jobChanges's list of changed paths against a scratch repo
// whose git config tries to reshape it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { jobChanges, selectTests, worktreeFiles, type RelatedTests } from './related-tests.ts';
import { defaults } from '#core/config/keys/defaults.ts';
import type { Config } from '#core/types.ts';

const RULES = defaults().relatedTests;

// The worktree's existing files: sources, their tests in every default layout, and hostile names.
const FILES = [
  'agents/builder.md',
  'docs/x.md',
  'lib/a/b/mod.ts',
  'lib/a/b/mod.test.ts',
  'lib/a/b/mod.spec.js',
  'lib/a/b/__tests__/mod.js',
  // Matches the template {dir}/test_{name}.* but no tests glob, so it is never selected.
  'lib/a/b/test_mod.ts',
  'lib/a/b/other.test.ts',
  'test/mod.test.ts',
  'test/x/mod-extra.test.ts',
  'test/step.test.ts',
  'test/helpers.ts',
  'tests/unit/test_mod.py',
  'mod.ts',
  'mod.test.ts',
  'app/x.ts',
  'app/x.test.ts',
  'app/models/user.rb',
  'spec/models/user_spec.rb',
  'lib/h/ok.test.ts',
  'lib/h/-rf.test.ts',
  '-x/ok.test.ts',
  "lib/h/it's.test.ts",
  'lib/h/back\\slash.test.ts',
  'lib/h/ctl\x01.test.ts',
];

const CUSTOM: Config['relatedTests'] = { tests: ['spec/**/*_spec.rb'], map: ['spec/**/{name}_spec.rb'], full: [] };

test('selectTests picks the tests related to the changed files', () => {
  const rows: { name: string; changed: string[]; rules?: Config['relatedTests']; prefix?: string; want: RelatedTests }[] = [
    {
      name: 'a source file selects its tests in every default layout, sorted and once each',
      changed: ['lib/a/b/mod.ts', 'lib/a/b/mod.test.ts'],
      want: {
        mode: 'files',
        files: ['lib/a/b/__tests__/mod.js', 'lib/a/b/mod.spec.js', 'lib/a/b/mod.test.ts', 'test/mod.test.ts', 'test/x/mod-extra.test.ts', 'tests/unit/test_mod.py'],
        changed: 2,
      },
    },
    { name: 'a changed test file selects itself, and one under test/ never triggers full', changed: ['test/step.test.ts'], want: { mode: 'files', files: ['test/step.test.ts'], changed: 1 } },
    { name: 'a changed test file that no longer exists is dropped', changed: ['lib/a/b/gone.test.ts'], want: { mode: 'none', files: [], changed: 1 } },
    {
      name: 'a root file maps through {dir}/ templates without the prefix',
      changed: ['mod.ts'],
      want: { mode: 'files', files: ['mod.test.ts', 'test/mod.test.ts', 'test/x/mod-extra.test.ts', 'tests/unit/test_mod.py'], changed: 1 },
    },
    { name: 'a shared helper under test/ runs the full suite', changed: ['lib/a/b/mod.ts', 'test/helpers.ts'], want: { mode: 'full', files: [], changed: 2, trigger: 'test/helpers.ts' } },
    { name: 'a fixture runs the full suite; the trigger is the first in sort order', changed: ['test/helpers.ts', 'test/fixtures/x.json'], want: { mode: 'full', files: [], changed: 2, trigger: 'test/fixtures/x.json' } },
    { name: 'a mock runs the full suite', changed: ['src/__mocks__/m.ts'], want: { mode: 'full', files: [], changed: 1, trigger: 'src/__mocks__/m.ts' } },
    { name: 'docs and prompts have no related test', changed: ['docs/x.md', 'agents/builder.md'], want: { mode: 'none', files: [], changed: 2 } },
    { name: 'no changes run nothing', changed: [], want: { mode: 'none', files: [], changed: 0 } },
    { name: 'a custom block selects through its own templates', changed: ['app/models/user.rb'], rules: CUSTOM, want: { mode: 'files', files: ['spec/models/user_spec.rb'], changed: 1 } },
    { name: 'a custom block replaces the default templates and tests', changed: ['lib/a/b/mod.ts', 'test/step.test.ts', 'test/helpers.ts'], rules: CUSTOM, want: { mode: 'none', files: [], changed: 3 } },
    {
      name: 'option-like and unshellable test paths are skipped, not passed',
      changed: ['lib/h/ok.test.ts', 'lib/h/-rf.test.ts', '-x/ok.test.ts', "lib/h/it's.test.ts", 'lib/h/back\\slash.test.ts', 'lib/h/ctl\x01.test.ts'],
      want: { mode: 'files', files: ['lib/h/ok.test.ts'], changed: 6, skipped: ['-x/ok.test.ts', 'lib/h/-rf.test.ts', 'lib/h/back\\slash.test.ts', 'lib/h/ctl\x01.test.ts', "lib/h/it's.test.ts"] },
    },
    { name: 'only skipped tests run nothing', changed: ['lib/h/-rf.test.ts'], want: { mode: 'none', files: [], changed: 1, skipped: ['lib/h/-rf.test.ts'] } },
    { name: 'a changed path with * is not filled into templates', changed: ['lib/a/b/*.ts'], want: { mode: 'none', files: [], changed: 1 } },
    { name: 'a changed path with ? is not filled into templates', changed: ['lib/a/b/mo?.ts'], want: { mode: 'none', files: [], changed: 1 } },
    { name: 'a component prefix keeps only its tests, relative to it', changed: ['app/x.ts', 'lib/a/b/mod.test.ts'], prefix: 'app', want: { mode: 'files', files: ['x.test.ts'], changed: 2 } },
    { name: 'a component prefix with no test under it runs nothing', changed: ['lib/a/b/mod.test.ts'], prefix: 'app', want: { mode: 'none', files: [], changed: 1 } },
  ];
  for (const row of rows) assert.deepEqual(selectTests(row.changed, FILES, row.rules ?? RULES, row.prefix), row.want, row.name);
});

test('jobChanges lists every change since the merge-base', () => {
  const repo = tempRepo();
  try {
    const { dir, git } = repo;
    const write = (p: string, text = `${p}\n`) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    };
    for (const p of ['a.txt', 'del.txt', 'old.txt', 'staged.txt', 'sub/keep.txt']) write(p);
    write('.gitignore', 'ignored.txt\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'job');
    // Committed on the job branch: a new file with a non-ASCII name, and a rename.
    write('committed-café.txt');
    git('mv', 'old.txt', 'new.txt');
    git('add', '-A');
    git('commit', '-qm', 'job');
    write('staged.txt', 'staged\n');
    git('add', 'staged.txt');
    write('a.txt', 'edited\n');
    fs.rmSync(path.join(dir, 'del.txt'));
    write('untracked.txt');
    write('ignored.txt');
    // Branch-writable config that would reshape the list if it were not pinned.
    git('config', 'diff.relative', 'true');
    git('config', 'diff.renames', 'true');
    git('config', 'core.quotePath', 'true');
    git('config', 'status.relativePaths', 'true');
    const changed = jobChanges(dir, defaults(), { base: 'main' });
    assert.deepEqual(changed, ['a.txt', 'committed-café.txt', 'del.txt', 'new.txt', 'old.txt', 'staged.txt', 'untracked.txt']);
    // The files a selection may pass: what exists on disk, untracked included, ignored and deleted not.
    const files = worktreeFiles(dir);
    assert.ok(files.includes('untracked.txt') && files.includes('committed-café.txt') && files.includes('sub/keep.txt'));
    assert.ok(!files.includes('del.txt') && !files.includes('ignored.txt') && !files.includes('old.txt'));
    assert.throws(() => jobChanges(dir, defaults(), { base: 'nope' }), /base nope not found/);
  } finally {
    repo.cleanup();
  }
});
