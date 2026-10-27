// The mandate contract: what forge mandate new|edit refuses (in-process, through the CLI's router), the
// contract as it applies under the config, the derived state and chain, and the files a read refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, repoTemplate } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import * as yaml from '#core/format/yaml.ts';
import { MANDATE_SCHEMA_VERSION } from '#core/versions/mandate.ts';
import { applyInput, blankMandate, effectiveContract, isReadable, mandateChain, mandateState, mandateSummary } from './contract.ts';
import { ForgeError } from '#core/errors.ts';
import { jobMandateScoring, listMandates, newMandateId, readMandate, writeMandate } from './store.ts';
import type { Config } from '#core/types.ts';
import type { Mandate, MandateInput, ReadMandate } from './types.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'split-approval', 'conflicts'], reserved: ['gate:conflicts'] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** Every file under the mandates dir with its content: what a refused write must leave as it was. */
function snapshot(root: string): Record<string, string> {
  const dir = path.join(root, '.forge', 'runtime', 'mandates');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.lstatSync(path.join(dir, f)).isSymbolicLink() ? '<link>' : fs.readFileSync(path.join(dir, f), 'utf8')]));
}

async function ok(root: string, args: string[]) {
  const r = await forgeInProcess(root, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
  return r.data as any;
}

test('mandate input refusals', async () => {
  const r = scratch();
  const bad = scratch();
  try {
    // foreman.reserved with a mis-written class reservation can't be read: every gate stays with a human.
    const cfg = path.join(bad.dir, '.forge', 'config.yml');
    const parsed = yaml.parse(fs.readFileSync(cfg, 'utf8'));
    parsed.foreman.reserved = ['gate:nope'];
    fs.writeFileSync(cfg, yaml.stringify(parsed));
    await ok(r.dir, ['mandate', 'new', 'a', '--title', 'A', '--milestones', 'M1']);
    await ok(r.dir, ['mandate', 'new', 'b', '--title', 'B', '--milestones', 'M2', '--after', 'a']);
    await ok(r.dir, ['mandate', 'new', 'c', '--title', 'C', '--labels', 'docs']);
    await ok(r.dir, ['mandate', 'close', 'c']);
    // A filed goal mandate: an ordinary scoped mandate over its milestone.
    const filed: Mandate = { ...applyInput(blankMandate('f', '2026-10-01T00:00:00.000Z'), { title: 'F', goal: 'Ship it', milestones: ['M1'] }), filedAt: '2026-10-02T00:00:00.000Z' };
    writeMandate(r.dir, () => ({ mandate: filed, action: 'filed' as const }));
    assert.deepEqual((readMandate(r.dir, 'f') as Mandate).scope.milestones, ['M1'], 'with filedAt set, a goal mandate has a scope');
    const NEW = ['mandate', 'new', 'x', '--title', 'X', '--milestones', 'M1'];
    const rows: [string, string[], RegExp, string?][] = [
      ['a class outside foreman.decides', [...NEW, '--decides', 'escalation'], /^escalation is not in foreman\.decides$/],
      ['a gate:<class> reserved class', [...NEW, '--decides', 'conflicts'], /^conflicts is reserved \(gate:conflicts\)$/],
      ['an invalid foreman.reserved', [...NEW, '--decides', 'spec-approval'], /foreman\.reserved is invalid: every gate stays with a human until it is fixed/, bad.dir],
      ['an unknown class', [...NEW, '--decides', 'nope'], /^nope is not a gate class$/],
      ['an empty scope', ['mandate', 'new', 'x', '--title', 'X'], /^a mandate's scope needs at least one milestone, label or issue, or a goal$/],
      ...(['milestones', 'labels', 'issues'] as const).map((k): [string, string[], RegExp] => [
        `a goal with --${k}`,
        ['mandate', 'new', 'x', '--title', 'X', '--goal', 'Ship it', `--${k}`, k === 'issues' ? 'some-item' : 'M1', ...(k === 'issues' ? ['--order', 'listed'] : [])],
        /^a goal mandate's scope stays empty until its draft is filed$/,
      ]),
      ['an empty goal', ['mandate', 'new', 'x', '--title', 'X', '--goal', ''], /^a goal needs at least one character that is not whitespace$/],
      ['a whitespace-only goal', ['mandate', 'new', 'x', '--title', 'X', '--goal', ' \r\n\t '], /^a goal needs at least one character that is not whitespace$/],
      ['a goal of 4001 characters', ['mandate', 'new', 'x', '--title', 'X', '--goal', 'g'.repeat(4001)], /^the goal must be at most 4000 characters \(got 4001\)$/],
      ...[0x07, 0x2028, 0x85].map((c): [string, string[], RegExp] => [
        `a goal holding U+${c.toString(16).padStart(4, '0').toUpperCase()}`,
        ['mandate', 'new', 'x', '--title', 'X', '--goal', `ship${String.fromCharCode(c)}it`],
        /^the goal must hold no control character but line feed and tab, and no line or paragraph separator$/,
      ]),
      ['listed without issues', [...NEW, '--order', 'listed'], /order listed needs scope\.issues and no milestones or labels/],
      ['issues without listed', ['mandate', 'new', 'x', '--title', 'X', '--issues', 'some-item'], /scope\.issues needs order listed/],
      ['a milestone starting -', ['mandate', 'new', 'x', '--title', 'X', '--milestones', '-x'], /milestone "-x" must be 1-200 characters, not start with "-"/],
      ['a label with a newline', ['mandate', 'new', 'x', '--title', 'X', '--labels', 'a\nb'], /label "a\\nb" must be 1-100 characters/],
      ['a milestone with a zero-width space', ['mandate', 'new', 'x', '--title', 'X', '--milestones', `M${String.fromCharCode(0x200b)}1`], /^milestone "M.1" must be 1-200 characters, not start with "-" and have no control or hidden characters$/],
      ['id ../x', ['mandate', 'new', '../x', '--title', 'X', '--milestones', 'M1'], /mandate id "\.\.\/x" is not a mandate id/],
      ['id none', ['mandate', 'new', 'none', '--title', 'X', '--milestones', 'M1'], /mandate id "none" is not a mandate id/],
      ['id M1', ['mandate', 'new', 'M1', '--title', 'X', '--milestones', 'M1'], /mandate id "M1" is not a mandate id/],
      ['after a missing mandate', [...NEW, '--after', 'nope'], /^--after nope: no mandate nope$/],
      ['after itself', [...NEW, '--after', 'x'], /^--after x: a mandate can't follow itself$/],
      ['a second successor', [...NEW, '--after', 'a'], /^--after a: mandate b already follows a \(chains stay linear\)$/],
      ['a cycle on edit', ['mandate', 'edit', 'a', '--after', 'b'], /^--after b: that would close a cycle/],
      ['maxJobs 0', [...NEW, '--max-jobs', '0'], /^maxJobs must be an integer 1-16 \(got 0\)$/],
      ['maxJobs 17', [...NEW, '--max-jobs', '17'], /^maxJobs must be an integer 1-16 \(got 17\)$/],
      ['maxJobs not a number', [...NEW, '--max-jobs', 'two'], /^maxJobs must be an integer 1-16 \(got NaN\)$/],
      ['budget.usd 0', [...NEW, '--budget-usd', '0'], /^budget\.usd must be a number over 0 and at most 100000 \(got 0\)$/],
      ['an unknown enum value', [...NEW, '--until', 'released'], /^until must be one of merge-ready \| merged/],
      ['an unknown scoring term on new', [...NEW, '--scoring', 'some'], /^scoring must be one of all \| sample \| off \(got "some"\)$/],
      ['an unknown scoring term on edit', ['mandate', 'edit', 'a', '--scoring', 'some'], /^scoring must be one of all \| sample \| off \(got "some"\)$/],
      ['every problem, joined', [...NEW, '--max-jobs', '0', '--stall-bounces', '101'], /^maxJobs must be an integer 1-16 \(got 0\); stall\.bounces must be an integer 1-100 \(got 101\)$/],
      ['editing a closed mandate', ['mandate', 'edit', 'c', '--title', 'Again'], /^mandate c is closed$/],
      ['pausing a closed mandate', ['mandate', 'pause', 'c'], /^mandate c is closed$/],
      ['a body of 8001 characters', [...NEW, '--body', 'x'.repeat(8001)], /the body must be at most 8000 characters \(got 8001\)/],
      ['a title empty after cleaning', ['mandate', 'new', 'x', '--title', ' \n ', '--milestones', 'M1'], /^a mandate needs a title$/],
      ['an existing id', ['mandate', 'new', 'a', '--title', 'A', '--milestones', 'M1'], /^mandate a exists/],
      ["a filed goal mandate's scope edited to empty", ['mandate', 'edit', 'f', '--milestones', 'none'], /^a filed goal mandate's scope needs at least one milestone, label or issue$/],
    ];
    for (const [name, args, want, root = r.dir] of rows) {
      const before = snapshot(root);
      const res = await forgeInProcess(root, args);
      assert.equal(res.status, 1, `${name}: ${JSON.stringify(res)}`);
      assert.match(res.error?.message ?? '', want, name);
      assert.deepEqual(snapshot(root), before, `${name}: the mandates dir is unchanged`);
    }
    const missing = await forgeInProcess(r.dir, ['mandate', 'edit', 'nope', '--title', 'N']);
    assert.deepEqual([missing.status, missing.error?.code], [1, 'not_found']);
    // filedAt is only ever a goal mandate's ISO time: any other file is refused on read.
    const plain = applyInput(blankMandate('p', '2026-10-01T00:00:00.000Z'), { title: 'P', milestones: ['M1'] });
    for (const [id, m, want] of [
      ['p', { ...plain, filedAt: '2026-10-02T00:00:00.000Z' }, 'filedAt is set only on a goal mandate, when its draft is filed'],
      ['q', { ...filed, id: 'q', filedAt: 'soon' }, 'filedAt must be null or an ISO time'],
    ] as const) {
      writeMandate(r.dir, () => ({ mandate: { ...m, id } as Mandate, action: 'new' as const }));
      assert.deepEqual(readMandate(r.dir, id), { id, problem: want }, id);
    }
  } finally {
    r.cleanup();
    bad.cleanup();
  }
});

test('a goal round-trips through the mandate file', async () => {
  const r = scratch();
  try {
    const goals = [
      '   leading spaces on the first line\nthen more',
      'two trailing newlines\n\n',
      'above\n---\nbelow',
      '# not a heading "quoted" and #hash',
      'a\ttab\tand a back\\slash and \\\' and \'single\'',
      'non-ASCII: café, 日本語, emoji 🚀',
    ];
    goals.forEach((goal, i) => {
      const m = applyInput(blankMandate(`g${i}`, '2026-10-01T00:00:00.000Z'), { title: `G${i}`, goal });
      writeMandate(r.dir, () => ({ mandate: m, action: 'new' as const }));
      const back = readMandate(r.dir, `g${i}`);
      assert.ok(isReadable(back), `${JSON.stringify(goal)}: ${JSON.stringify(back)}`);
      assert.equal(back.goal, goal, JSON.stringify(goal));
      assert.equal(back.body, '');
      // The goal is the last frontmatter key, on one double-quoted line.
      const lines = fs.readFileSync(path.join(r.dir, '.forge', 'runtime', 'mandates', `g${i}.md`), 'utf8').split('\n');
      const end = lines.indexOf('---', 1);
      assert.match(lines[end - 1], /^goal: ".*"$/, JSON.stringify(goal));
    });
    const plain = readMandate(r.dir, 'g0');
    assert.ok(isReadable(plain) && mandateSummary(plain, [plain]).intake);
  } finally {
    r.cleanup();
  }
});

const config = (edit: (f: Config['foreman']) => void = () => {}): Config => {
  const c = defaults();
  c.foreman.enabled = true;
  edit(c.foreman);
  return c;
};
const mandate = (id: string, input: MandateInput & { status?: Mandate['status'] } = {}): Mandate => {
  const { status, ...rest } = input;
  const m = applyInput(blankMandate(id, '2026-10-01T00:00:00.000Z'), { title: id, milestones: ['M1'], ...rest });
  return status ? { ...m, status } : m;
};

test('effective contract', () => {
  const m = mandate('m', { decides: ['spec-approval', 'conflicts'], until: 'merged' });
  const rows: [string, Config, { decides: string[]; until: string }, string[]][] = [
    [
      'a class dropped from foreman.decides after it was written',
      config((f) => (f.decides = ['spec-approval'])),
      { decides: ['spec-approval'], until: 'merge-ready' },
      ['decides: conflicts dropped (not in foreman.decides)', 'until: merged needs foreman.ship: merge; merge-ready applies'],
    ],
    ['a class reserved later', config((f) => (f.reserved = [...f.reserved, 'gate:conflicts'])), { decides: ['spec-approval'], until: 'merge-ready' }, ['decides: conflicts dropped (reserved: gate:conflicts)', 'until: merged needs foreman.ship: merge; merge-ready applies']],
    ['foreman.enabled false', config((f) => (f.enabled = false)), { decides: [], until: 'merge-ready' }, ['decides: none apply (foreman.enabled is false)', 'until: merged needs foreman.ship: merge; merge-ready applies']],
    ['an invalid reserved', config((f) => (f.reserved = ['Gate:release'])), { decides: [], until: 'merge-ready' }, ['decides: none apply (foreman.reserved is invalid)', 'until: merged needs foreman.ship: merge; merge-ready applies']],
    ['until merged under ship: merge', config((f) => (f.ship = 'merge')), { decides: ['spec-approval', 'conflicts'], until: 'merged' }, []],
  ];
  for (const [name, c, want, capped] of rows) {
    const got = effectiveContract(c, m);
    assert.deepEqual({ decides: got.effective.decides, until: got.effective.until }, want, name);
    assert.deepEqual(got.capped, capped, name);
    assert.deepEqual([got.effective.maxJobs, got.effective.budget], [m.maxJobs, m.budget], `${name}: the other terms are as written`);
  }
});

test('mandate state and chain', () => {
  const link1 = mandate('l1');
  const link2 = mandate('l2', { after: 'l1' });
  const link3 = mandate('l3', { after: 'l2' });
  const unreadable: ReadMandate = { id: 'gone', problem: 'a symlink, not a regular file' };
  const rows: [string, ReadMandate[], Record<string, string>, string[], string | null][] = [
    ['a three-link chain', [link1, link2, link3], { l1: 'active', l2: 'waiting', l3: 'waiting' }, ['l1', 'l2', 'l3'], 'l1'],
    ['link 1 closed', [{ ...link1, status: 'closed' }, link2, link3], { l1: 'closed', l2: 'active', l3: 'waiting' }, ['l1', 'l2', 'l3'], 'l2'],
    ['link 2 paused', [{ ...link1, status: 'closed' }, { ...link2, status: 'paused' }, link3], { l1: 'closed', l2: 'paused', l3: 'waiting' }, ['l1', 'l2', 'l3'], 'l2'],
    ['every link closed', [link1, link2, link3].map((m) => ({ ...m, status: 'closed' as const })), { l1: 'closed', l2: 'closed', l3: 'closed' }, ['l1', 'l2', 'l3'], null],
    ['after an unreadable mandate', [unreadable, mandate('after-gone', { after: 'gone' })], { 'after-gone': 'waiting' }, ['gone', 'after-gone'], 'gone'],
    ['no after', [mandate('solo')], { solo: 'active' }, ['solo'], 'solo'],
  ];
  for (const [name, all, states, chain, activeLink] of rows) {
    for (const [id, state] of Object.entries(states)) {
      const m = all.find((x) => x.id === id) as Mandate;
      assert.equal(mandateState(m, all), state, `${name}: ${id}`);
      assert.deepEqual(mandateChain(m, all), { chain, activeLink }, `${name}: ${id}'s chain`);
    }
  }
});

test('unreadable mandate files', async () => {
  const r = scratch();
  try {
    await ok(r.dir, ['mandate', 'new', 'good', '--title', 'Good', '--milestones', 'M1', '--body', 'Ship it.']);
    const dir = path.join(r.dir, '.forge', 'runtime', 'mandates');
    const good = fs.readFileSync(path.join(dir, 'good.md'), 'utf8');
    assert.equal((readMandate(r.dir, 'good') as Mandate).body, 'Ship it.', 'the file reads back');
    const rows: [string, () => void, RegExp][] = [
      ['a symlink', () => fs.symlinkSync(path.join(dir, 'good.md'), path.join(dir, 'link.md')), /symlink/],
      ['over 64 KiB', () => fs.writeFileSync(path.join(dir, 'big.md'), good + 'x'.repeat(70 * 1024)), /larger than 64 KiB/],
      ['malformed frontmatter', () => fs.writeFileSync(path.join(dir, 'broken.md'), '---\nid: [broken\n---\n'), /bad frontmatter/],
      ['no frontmatter', () => fs.writeFileSync(path.join(dir, 'plain.md'), 'just text\n'), /no frontmatter/],
      ['a newer schemaVersion', () => fs.writeFileSync(path.join(dir, 'newer.md'), good.replace('id: good', 'id: newer').replace(/schemaVersion: \d+/, `schemaVersion: ${MANDATE_SCHEMA_VERSION + 1}`)), /newer Forge/],
      ['an id that differs from its file name', () => fs.writeFileSync(path.join(dir, 'other.md'), good), /differs from its file name/],
      ['a term that breaks the rules', () => fs.writeFileSync(path.join(dir, 'wide.md'), good.replace('id: good', 'id: wide').replace(/maxJobs: \d+/, 'maxJobs: 99')), /maxJobs must be an integer 1-16/],
      ['an unknown key', () => fs.writeFileSync(path.join(dir, 'extra.md'), good.replace('id: good', 'id: extra').replace('---\n', '---\nwiden: true\n')), /unknown key "widen"/],
      ['a current file with no scoring', () => fs.writeFileSync(path.join(dir, 'unscored.md'), good.replace('id: good', 'id: unscored').replace(/^scoring: all\n/m, '')), /^no scoring$/],
      ['an unknown scoring term', () => fs.writeFileSync(path.join(dir, 'maybe.md'), good.replace('id: good', 'id: maybe').replace(/^scoring: all$/m, 'scoring: maybe')), /^scoring must be one of all \| sample \| off \(got "maybe"\)$/],
    ];
    const ids = ['link', 'big', 'broken', 'plain', 'newer', 'other', 'wide', 'extra', 'unscored', 'maybe'];
    rows.forEach(([, plant]) => plant());
    rows.forEach(([name, , want], i) => {
      const m = readMandate(r.dir, ids[i]);
      assert.ok('problem' in m && want.test(m.problem), `${name}: ${JSON.stringify(m)}`);
    });
    const listed = (await ok(r.dir, ['mandate', 'list'])).mandates as { id: string; problem?: string }[];
    assert.deepEqual(listed.filter((x) => x.problem).map((x) => x.id).sort(), [...ids].sort(), 'list shows each as { id, problem }');
    for (const x of listed.filter((y) => y.problem)) assert.deepEqual(Object.keys(x).sort(), ['id', 'problem']);
    assert.ok(isReadable(listMandates(r.dir).find((m) => m.id === 'good')), 'the good file still reads beside them');
    // An unreadable mandate is never acted on: no write goes through it.
    const edit = await forgeInProcess(r.dir, ['mandate', 'pause', 'wide']);
    assert.deepEqual([edit.status, edit.error?.message], [1, "mandate wide can't be read (maxJobs must be an integer 1-16 (got 99))"]);
  } finally {
    r.cleanup();
  }
});

test('a generated mandate id is never one already taken', async () => {
  const r = scratch();
  try {
    await ok(r.dir, ['mandate', 'new', 'm-00000001', '--title', 'Taken', '--milestones', 'M1']);
    const dir = path.join(r.dir, '.forge', 'runtime', 'mandates');
    fs.writeFileSync(path.join(dir, 'm-00000002.md'), 'not a mandate\n');
    // A leftover runtime dir with no file beside it: an old mandate's survey, draft and ledger.
    fs.mkdirSync(path.join(dir, 'm-00000003'));
    fs.writeFileSync(path.join(dir, 'm-00000003', 'ledger.jsonl'), '');
    fs.symlinkSync(path.join(r.dir, 'nowhere'), path.join(dir, 'm-00000004.md'));
    const all = listMandates(r.dir);
    const seq = (values: string[]) => {
      let i = 0;
      return () => values[i++] ?? 'ffffffff';
    };
    const rows: [string, string[], string][] = [
      ['a free first candidate', ['0000000a'], 'm-0000000a'],
      ['a readable mandate', ['00000001', '0000000b'], 'm-0000000b'],
      ['an unreadable <id>.md', ['00000002', '0000000c'], 'm-0000000c'],
      ['a bare runtime dir', ['00000003', '0000000d'], 'm-0000000d'],
      ['a dangling link at <id>.md', ['00000004', '0000000e'], 'm-0000000e'],
      ['a candidate that is no mandate id', ['NOT/HEX', '0000000f'], 'm-0000000f'],
      ['each kind in a row', ['00000001', '00000002', '00000003', '00000004', 'X', '00000010'], 'm-00000010'],
    ];
    for (const [name, values, want] of rows) assert.equal(newMandateId(r.dir, all, seq(values)), want, name);
    // The list alone, with no file on disk: a mandate the caller read is taken.
    assert.equal(newMandateId(r.dir, [...all, mandate('m-00000020')], seq(['00000020', '00000021'])), 'm-00000021', 'a listed mandate');
    assert.match(newMandateId(r.dir, all), /^m-[0-9a-f]{8}$/, 'the default draws 8 random hex digits');

    const before = fs.readdirSync(dir).sort();
    let calls = 0;
    assert.throws(
      () =>
        newMandateId(r.dir, all, () => {
          calls++;
          return ['00000001', '00000002', '00000003'][calls % 3]!;
        }),
      (e: unknown) => e instanceof ForgeError && e.exitCode === 1 && e.message === "couldn't pick an unused mandate id; pass one",
    );
    assert.equal(calls, 16, 'it gives up after 16 taken candidates');
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'the mandates dir is unchanged');
  } finally {
    r.cleanup();
  }
});

test("a job's mandate scoring term", async () => {
  const r = scratch();
  try {
    await ok(r.dir, ['mandate', 'new', 'all', '--title', 'All', '--milestones', 'M1']);
    await ok(r.dir, ['mandate', 'new', 'sampled', '--title', 'Sampled', '--milestones', 'M2', '--scoring', 'sample']);
    await ok(r.dir, ['mandate', 'pause', 'sampled']);
    await ok(r.dir, ['mandate', 'new', 'off', '--title', 'Off', '--milestones', 'M3', '--scoring', 'off']);
    await ok(r.dir, ['mandate', 'new', 'closed', '--title', 'Closed', '--milestones', 'M4']);
    await ok(r.dir, ['mandate', 'close', 'closed']);
    await ok(r.dir, ['mandate', 'close', 'off']);
    const dir = path.join(r.dir, '.forge', 'runtime', 'mandates');
    fs.symlinkSync(path.join(dir, 'all.md'), path.join(dir, 'linked.md'));
    const rows: [string, string | null, string | null][] = [
      ['no mandate', null, null],
      ['an active mandate, all by default', 'all', 'all'],
      ['a paused mandate that samples', 'sampled', 'sample'],
      ['a closed mandate that scores off', 'off', 'off'],
      ['a closed mandate that scores all', 'closed', 'all'],
      ['a missing mandate file', 'nope', null],
      ['a link at the mandate file', 'linked', null],
    ];
    for (const [name, mandate, want] of rows) assert.equal(jobMandateScoring(r.dir, { mandate }), want, name);
  } finally {
    r.cleanup();
  }
});
