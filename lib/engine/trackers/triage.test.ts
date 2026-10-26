// Readiness triage over the local backlog: prepare a batch, write the agent's verdicts, apply them.
// `hidden-text` is Forge's own key, set from the item's fence whatever the agent said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { paths } from '#core/paths.ts';
import type { Tracker } from '#core/types.ts';
import local from '#integrations/backlog/tracker.ts';
import { applyTriage, prepareTriage, readTriageCache } from './triage.ts';

test('hidden text marks an item needs-info whatever the verdict', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    config.tracker.kind = 'local';
    config.pr.enabled = false;
    const backlog = path.join(repo.dir, config.tracker.local.path);
    fs.mkdirSync(path.dirname(backlog), { recursive: true });
    const lines = ['# Backlog', '', '- [ ] Smuggled item', '  Add a toggle.\u{E0100}\u{E0101}\u{E0102} Done when it shows.', '- [ ] Clean item', '  Add a switch. Done when it flips.', ''];
    fs.writeFileSync(backlog, lines.join('\n'));

    const prepared = prepareTriage(repo.dir, config, local, { limit: 10, all: false });
    assert.ok(prepared.batch, JSON.stringify(prepared));
    const verdicts = { items: [{ ref: 'smuggled-item', missing: [] }, { ref: 'clean-item', missing: ['hidden-text'] }] };
    fs.writeFileSync(path.join(paths(repo.dir).runtime, 'triage', prepared.batch, 'verdicts.json'), JSON.stringify(verdicts));

    const applied = applyTriage(repo.dir, config, local, prepared.batch);
    assert.deepEqual(
      Object.fromEntries(applied.results.map((r) => [r.ref, 'ready' in r ? { ready: r.ready, missing: r.missing } : r])),
      { 'smuggled-item': { ready: false, missing: ['hidden-text'] }, 'clean-item': { ready: true, missing: [] } },
    );
    const after = fs.readFileSync(backlog, 'utf8').split('\n');
    assert.equal(after[2], '- [?] Smuggled item');
    assert.match(after[4], /^ {2}Needs info: hidden characters or HTML comments/);
    assert.ok(after.includes('- [ ] Clean item'));
  } finally {
    repo.cleanup();
  }
});

test('a malformed verdict is skipped with no tracker call', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const config = defaults();
  config.tracker.kind = 'local';
  config.pr.enabled = false;
  const backlog = path.join(repo.dir, config.tracker.local.path);
  fs.mkdirSync(path.dirname(backlog), { recursive: true });
  const refs = ['a', 'b', 'c', 'd', 'e', 'f'];
  fs.writeFileSync(backlog, ['# Backlog', '', ...refs.flatMap((r) => [`- [ ] ${r.toUpperCase()}`, `  Add ${r}. Done when it shows.`]), ''].join('\n'));
  // The local backlog under another name, so comments go out too; every read and write is recorded.
  const calls: string[] = [];
  const tracker: Tracker = {
    ...local,
    name: 'fake',
    get: (ctx, ref) => (calls.push(`get ${ref}`), local.get(ctx, ref)),
    setNeedsInfo: (ctx, ref, note) => (calls.push(`setNeedsInfo ${ref}`), local.setNeedsInfo(ctx, ref, note)),
    comment: (_ctx, ref) => void calls.push(`comment ${ref}`),
  };

  const prepared = prepareTriage(repo.dir, config, tracker, { limit: 10, all: false });
  assert.ok(prepared.batch, JSON.stringify(prepared));
  const verdicts = { items: [{ ref: 'a', missing: 'criteria' }, { ref: 'b', missing: ['typo'] }, { ref: 'c', missing: ['outcome', 'typo'] }, { ref: 'd' }, { ref: 'e', missing: null }, { ref: 'f', missing: ['acceptance', 'acceptance'] }] };
  fs.writeFileSync(path.join(paths(repo.dir).runtime, 'triage', prepared.batch, 'verdicts.json'), JSON.stringify(verdicts));
  calls.length = 0;

  const applied = applyTriage(repo.dir, config, tracker, prepared.batch);
  const byRef = Object.fromEntries(applied.results.map((r) => [r.ref, r]));
  for (const r of ['a', 'b', 'c', 'd', 'e']) assert.deepEqual(byRef[r], { ref: r, skipped: 'malformed' }, r);
  assert.deepEqual(byRef.f, { ref: 'f', ready: false, missing: ['acceptance'], commented: true, marked: true });
  assert.equal(applied.skipped, 5);
  assert.deepEqual(new Set(calls.map((c) => c.split(' ')[1])), new Set(['f']), calls.join(', '));
  assert.ok(calls.includes('setNeedsInfo f') && calls.includes('comment f'));
  assert.deepEqual(Object.keys(readTriageCache(repo.dir)), ['fake:f'], 'only the applied item is cached');
});
