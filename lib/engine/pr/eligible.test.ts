// The recorded decision bound to a head: old events never count, and a head follows the decided one
// only through clean merges of the base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { loadJob, readEvents, updateJob } from '#core/job/store.ts';
import { jobFiles } from '#core/paths.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { EVENT_STEPS } from '#core/versions/event.ts';
import type { JobEvent } from '#core/types.ts';
import { decisionCurrent, decisionEligible, headFollows, lastDecision } from './eligible.ts';

const config = defaults();

/** A repo whose branches hold each shape of head on top of the decided commit D (base: main). */
function history() {
  const repo = tempRepo();
  const rev = (r: string) => repo.git('rev-parse', r).toString().trim();
  const write = (f: string, text = `${f}\n`) => fs.writeFileSync(path.join(repo.dir, f), text);
  const commit = (f: string, msg = f) => {
    write(f);
    repo.git('add', '-A');
    repo.git('commit', '-qm', msg);
    return rev('HEAD');
  };
  const on = (branch: string, from: string) => repo.git('checkout', '-q', '-b', branch, from);
  const mergeMain = () => {
    repo.git('merge', '-q', '--no-ff', '--no-edit', 'main');
    return rev('HEAD');
  };
  on('feat', 'main');
  const D = commit('feature.txt');
  repo.git('checkout', '-q', 'main');
  commit('base1.txt');
  on('clean', D);
  const M1 = mergeMain();
  repo.git('checkout', '-q', 'main');
  commit('base2.txt');
  repo.git('checkout', '-q', 'clean');
  const M2 = mergeMain();
  on('plain', D);
  const P = commit('after.txt');
  on('evil', D);
  repo.git('merge', '-q', '--no-ff', '--no-commit', 'main');
  write('extra.txt', 'rides in the merge\n');
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'merge main');
  const E = rev('HEAD');
  on('side', D);
  const S = commit('side.txt');
  on('sidemerge', D);
  repo.git('merge', '-q', '--no-ff', '--no-edit', 'side');
  const SM = rev('HEAD');
  void S;
  on('rebased', D);
  repo.git('rebase', '-q', 'main');
  const R = rev('HEAD');
  repo.git('checkout', '-q', 'main');
  return { repo, D, M1, M2, P, E, SM, R, tree: rev(`${D}^{tree}`) };
}

test('headFollows: only the decided head or clean base merges on it', () => {
  const h = history();
  try {
    const base = { base: 'main' };
    const rows: [string, string, boolean][] = [
      ['the decided head itself', h.D, true],
      ['one clean base merge', h.M1, true],
      ['a chain of two clean base merges', h.M2, true],
      ['a plain commit after the decision', h.P, false],
      ["a merge whose tree differs from git's own (an evil merge)", h.E, false],
      ['a merge whose second parent is not on the base', h.SM, false],
      ['a rewritten (rebased) head', h.R, false],
      ['a head that is not a commit (a tree)', h.tree, false],
      ['a non-hex value', '--output=/tmp/x', false],
      ['a ref name', 'main', false],
    ];
    for (const [name, head, want] of rows) assert.equal(headFollows(h.repo.dir, config, base, h.D, head), want, name);
    assert.equal(headFollows(h.repo.dir, config, base, null, h.D), false, 'no decided head');
  } finally {
    h.repo.cleanup();
  }
});

test("headFollows: a merge whose tree is git's own conflict-marker output is not a clean merge", () => {
  const repo = tempRepo();
  try {
    const rev = (r: string) => repo.git('rev-parse', r).toString().trim();
    const edit = (text: string) => {
      fs.writeFileSync(path.join(repo.dir, 'c.txt'), text);
      repo.git('add', '-A');
      repo.git('commit', '-qm', text);
    };
    edit('base\n');
    repo.git('checkout', '-q', '-b', 'feat');
    edit('feat\n');
    const decided = rev('HEAD');
    repo.git('checkout', '-q', 'main');
    edit('main\n');
    let out = '';
    try {
      repo.git('merge-tree', '--write-tree', '--no-messages', decided, 'main');
    } catch (e) {
      // Exit 1: the merge conflicts, and the tree with its markers is still written.
      out = String((e as { stdout: Buffer }).stdout);
    }
    const tree = out.split('\n')[0].trim();
    assert.match(tree, /^[0-9a-f]{40}$/);
    const merge = repo.git('commit-tree', tree, '-p', decided, '-p', rev('main'), '-m', 'merge').toString().trim();
    assert.equal(headFollows(repo.dir, config, { base: 'main' }, decided, merge), false);
  } finally {
    repo.cleanup();
  }
});

test("a v3 events file's APPROVE is not eligible", () => {
  const repo = tempRepo();
  try {
    const id = jobAt(repo.dir, 'pr').id;
    // The version before decision-head bound decisions to a head.
    const v = EVENT_STEPS.findIndex((s) => s.id === 'decision-head') + 1;
    for (const f of jobFiles(repo.dir, id, 'events.jsonl')) fs.appendFileSync(f, `${JSON.stringify({ v, ts: new Date().toISOString(), type: 'decision', decision: 'APPROVE', reason: null })}\n`);
    const events = readEvents(repo.dir, id);
    const d = events.findLast((e) => e.type === 'decision')!;
    assert.equal(d.v, EVENT_SCHEMA_VERSION);
    assert.equal(decisionEligible(lastDecision(events)), false);
    assert.deepEqual(lastDecision(events), { decision: 'APPROVE', autoMerge: false, head: null, heads: {} });
  } finally {
    repo.cleanup();
  }
});

test("decisionCurrent reads every job repo's HEAD", () => {
  const h = history();
  try {
    const id = jobAt(h.repo.dir, 'pr').id;
    updateJob(h.repo.dir, id, (j) => {
      j.worktree = h.repo.dir;
      j.base = 'main';
    });
    const job = () => loadJob(h.repo.dir, id);
    const decision = (fields: Record<string, unknown>): JobEvent[] => [{ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), type: 'decision', decision: 'APPROVE', reason: null, autoMerge: true, head: h.D, ...fields }];
    const at = (branch: string) => h.repo.git('checkout', '-q', branch);
    at('feat');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), true, 'HEAD is the decided head');
    at('clean');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), true, 'HEAD follows it by clean base merges');
    at('plain');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), false, 'a further commit');
    at('feat');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({ autoMerge: false })), false, 'the decision is not eligible');
  } finally {
    h.repo.cleanup();
  }
});
