import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';
import type { Config } from '#core/types.ts';
import { retitleJob, withoutTitleLine, writtenPrTitle } from './rename.ts';

function scratch(edit: (c: Config) => void = () => {}) {
  const repo = tempRepo();
  const config = defaults();
  config.tracker.kind = 'none';
  edit(config);
  const job = jobAt(repo.dir, 'spec', { config, title: 'Make the switcher show agents' });
  const write = (file: string, text: string) => fs.writeFileSync(path.join(jobDir(repo.dir, job.id), file), text);
  const events = (type: string) => readEvents(repo.dir, job.id).filter((e) => e.type === type);
  return { root: repo.dir, config, id: job.id, branch: job.branch, write, events, cleanup: repo.cleanup };
}

test("retitleJob renames from the spec's heading and keeps the id and branch", () => {
  const s = scratch();
  try {
    s.write('spec.md', '\n# feat(dashboard): show agents in the switcher\n\nBody.\n');
    const r = retitleJob(s.root, s.config, s.id, 'spec');
    assert.deepEqual(r, { id: s.id, retitled: true, title: 'feat(dashboard): show agents in the switcher', from: 'spec' });
    const job = loadJob(s.root, s.id);
    assert.equal(job.title, 'feat(dashboard): show agents in the switcher');
    assert.equal(job.branch, s.branch);
    assert.deepEqual(s.events('retitled').map((e) => e.from), ['Make the switcher show agents']);
    // The same title again changes nothing and logs nothing.
    assert.equal(retitleJob(s.root, s.config, s.id, 'spec').retitled, false);
    assert.equal(s.events('retitled').length, 1);
  } finally {
    s.cleanup();
  }
});

test('retitleJob refuses a title that fails the schema and renames nothing', () => {
  const s = scratch();
  try {
    s.write('spec.md', '# Show agents in the switcher\n');
    const r = retitleJob(s.root, s.config, s.id, 'spec');
    assert.equal(r.retitled, false);
    assert.equal(loadJob(s.root, s.id).title, 'Make the switcher show agents');
    assert.equal(s.events('retitle-refused').length, 1);
    assert.equal(s.events('retitle-refused')[0].source, 'spec');
  } finally {
    s.cleanup();
  }
});

test('titles.job decides which sources rename', () => {
  const rows: [Config['titles']['job'], 'spec' | 'pr', boolean][] = [
    ['pr', 'spec', true],
    ['pr', 'pr', true],
    ['schema', 'spec', true],
    ['schema', 'pr', false],
    ['request', 'spec', false],
    ['request', 'pr', false],
  ];
  for (const [mode, from, renames] of rows) {
    const s = scratch((c) => {
      c.titles.job = mode;
    });
    try {
      s.write('spec.md', '# fix: a\n');
      s.write('pr.md', 'Title: fix: a\n\n## Summary\n');
      assert.equal(retitleJob(s.root, s.config, s.id, from).retitled, renames, `${mode} from ${from}`);
    } finally {
      s.cleanup();
    }
  }
});

test("pr.md's Title: line is read from the first non-empty line only, and dropped from the body", () => {
  const s = scratch();
  try {
    s.write('pr.md', '\nTitle: feat: x\n## Summary\n');
    assert.equal(writtenPrTitle(s.root, s.id), 'feat: x');
    s.write('pr.md', '## Summary\nTitle: feat: x\n');
    assert.equal(writtenPrTitle(s.root, s.id), null);
  } finally {
    s.cleanup();
  }
  assert.equal(withoutTitleLine('\nTitle: feat: x\n\n## Summary\n'), '\n## Summary\n');
  assert.equal(withoutTitleLine('## Summary\nTitle: kept\n'), '## Summary\nTitle: kept\n');
});
