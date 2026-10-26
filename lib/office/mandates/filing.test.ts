// Filing an approved milestone draft through decideDraft: what it files and how triage then sees it, every
// pre-flight refusal (nothing written anywhere), a filing that stops and resumes without filing twice, and
// the guarded tracker's own scan of milestone text. Against the local backlog only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MILESTONE_DRAFT, draftJson, forgeInProcess, initMilestoneRepo, readyGoal, repoTemplate, seedBacklog } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { enqueue } from '#core/job/requests.ts';
import { withLockAsync } from '#core/os/lock.ts';
import { paths } from '#core/paths.ts';
import local from '#integrations/backlog/tracker.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { prepareTriage } from '#engine/trackers/triage.ts';
import { filingFile, readFiling } from './filing.ts';
import { decideDraft, draftGate } from './gate.ts';
import { readMandate } from './store.ts';
import type { Config, EventActor, Tracker } from '#core/types.ts';
import type { Mandate } from './types.ts';

const scratch = repoTemplate((dir) => initMilestoneRepo(dir));
const ACTOR: EventActor = { login: 'owner', source: 'os' };
// Built at runtime, so no literal credential sits in the repo.
const ACCESS_KEY = ['AK', 'IA', 'Q3M7XK2P', 'Z9RT5WVN'].join('');

const backlog = (root: string) => path.join(root, '.forge', 'backlog.md');
const mdir = (root: string) => path.join(root, '.forge', 'runtime', 'mandates');

/** backlog.md, the mandate files and every file in g1's dir: what a refused approve must leave byte for byte. */
function snapshot(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = { backlog: fs.existsSync(backlog(root)) ? fs.readFileSync(backlog(root), 'utf8') : null };
  for (const f of fs.readdirSync(mdir(root)).filter((n) => n.endsWith('.md'))) out[f] = fs.readFileSync(path.join(mdir(root), f), 'utf8');
  const dir = path.join(mdir(root), 'g1');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) out[`g1/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}

const approve = (root: string, config: Config, tracker: () => Promise<Tracker>, pins: { request?: string; digest?: string } = {}) =>
  decideDraft(root, config, 'g1', 'approve', { ...pins, foreman: false, actor: ACTOR, tracker, env: {} });

const gateOf = (root: string, config: Config) => draftGate(root, config, readMandate(root, 'g1') as Mandate).status;

/** The local tracker with its calls counted, and `create` replaced where a row needs it to fail. */
function counting(create?: (n: number, item: Parameters<Tracker['create']>[1]) => ReturnType<Tracker['create']>) {
  const calls: Record<string, number> = {};
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const t: Tracker = {
    name: 'local',
    list: (c, o) => (count('list'), local.list(c, o)),
    get: (c, r) => (count('get'), local.get(c, r)),
    claim: (c, r, j) => local.claim(c, r, j),
    update: (c, r, j) => local.update(c, r, j),
    comment: () => void count('comment'),
    create: (c, item) => (count('create'), create ? create(calls.create, item) : local.create(c, item)),
    close: (c, r) => local.close(c, r),
    milestones: (c) => (count('milestones'), local.milestones(c)),
    createMilestone: (c, ms) => (count('createMilestone'), local.createMilestone(c, ms)),
    milestoneAdd: (c, r, o) => (count('milestoneAdd'), local.milestoneAdd(c, r, o)),
  };
  return { tracker: t, calls };
}

test('filed issues go through triage', async () => {
  const r = scratch();
  try {
    seedBacklog(r.dir);
    await readyGoal(r.dir, 'g1');
    const { config } = loadConfig(r.dir);
    const out = await approve(r.dir, config, () => loadTracker(r.dir, config));
    assert.equal(out.decision, 'approve');
    const created = out.decision === 'approve' ? out.filing.issues.filter((i) => i.action === 'created').map((i) => i.ref) : [];
    assert.deepEqual(created, ['sharper-code-lens', 'builder-brief-names-nits']);
    const batch = prepareTriage(r.dir, config, await loadTracker(r.dir, config), { limit: 20, all: true });
    const refs = batch.items.map((i) => i.ref);
    for (const ref of created) assert.ok(refs.includes(ref!), `${ref} in ${JSON.stringify(refs)}`);
  } finally {
    r.cleanup();
  }
});

interface RefusalRow {
  name: string;
  arrange?: (root: string) => Promise<{ request: string; digest: string }> | { request: string; digest: string } | void;
  /** The goal mandate's `new` flags and draft body. */
  flags?: string[];
  body?: unknown;
  config?: (c: Config) => void;
  tracker?: (root: string, config: Config) => Tracker;
  pins?: (d: { request: string; digest: string }) => { request?: string; digest?: string };
  want: RegExp;
  code?: string;
}

const withIssue = (i: number, patch: Record<string, unknown>) => ({ ...MILESTONE_DRAFT, issues: MILESTONE_DRAFT.issues.map((it, n) => (n === i ? { ...it, ...patch } : it)) });

test('approve refuses before any write', async () => {
  const bare: Tracker = { name: 'stub', list: () => [], get: () => null, claim: () => ({ ok: true }), update: () => {}, comment: () => {}, create: () => ({ ref: 'x' }), close: () => {} };
  const rows: RefusalRow[] = [
    { name: 'a likely secret in an issue body', body: withIssue(0, { why: `Use ${ACCESS_KEY} for it.` }), want: /possible secret in the milestone draft/, code: 'secret_found' },
    { name: 'tracker.kind none', config: (c) => (c.tracker.kind = 'none'), want: /^tracker none can't create milestones/ },
    { name: 'a tracker without createMilestone', tracker: () => bare, want: /^tracker stub can't create milestones, so a draft can't be filed there$/ },
    { name: 'the milestone heading exists', arrange: (root) => seedBacklog(root, '\n## Fewer review rounds\n'), want: /^milestone "Fewer review rounds" already exists in the tracker; revise the draft$/ },
    { name: 'a new issue titled like an item', arrange: (root) => seedBacklog(root, '- [ ] Sharper code lens\n'), want: /^issues\[0\]'s title matches sharper-code-lens; revise the draft to reuse it$/ },
    { name: 'an existing ref get does not find', body: withIssue(1, { existing: { ref: 'missing-item', action: 'reuse' } }), want: /^issues\[1\]\.existing\.ref names no item in the tracker$/ },
    { name: 'an existing ref that is done', arrange: (root) => fs.writeFileSync(backlog(root), '# Backlog\n\n- [x] Old item\n'), want: /^issues\[1\]\.existing\.ref is no longer open/ },
    { name: 'order listed', flags: ['--order', 'listed'], want: /order listed needs scope\.issues and no milestones or labels; forge mandate edit g1 --order graph$/ },
    { name: 'a milestone title starting -', body: { ...MILESTONE_DRAFT, milestone: { ...MILESTONE_DRAFT.milestone, title: '-rf' } }, want: /^the milestone title must be 1-200 characters, not start with "-"/ },
    { name: '--request naming another request', pins: (d) => ({ request: '1-other', digest: d.digest }), want: /^the draft changed since you read it \(now \d+-\w+\)$/ },
    { name: '--digest that is not the current one', pins: (d) => ({ request: d.request, digest: 'c'.repeat(64) }), want: /^the draft changed since you read it \(digest now [0-9a-f]{12}\)$/ },
    {
      name: 'draft.json rewritten after show',
      pins: (d) => {
        // Still a valid draft, other bytes: the digest show returned no longer matches.
        fs.writeFileSync(draftJson(currentRoot, 'g1'), JSON.stringify(JSON.parse(fs.readFileSync(draftJson(currentRoot, 'g1'), 'utf8'))));
        return { request: d.request, digest: d.digest };
      },
      want: /^the draft changed since you read it \(digest now [0-9a-f]{12}\)$/,
    },
    { name: 'a pending draft request', arrange: (root) => void enqueue(root, null, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' }), want: /^mandate g1's draft is not waiting for approval \(draft status queued\)$/ },
    { name: 'a paused mandate', arrange: async (root) => void (await forgeInProcess(root, ['mandate', 'pause', 'g1'])), want: /^mandate g1 is paused; resume it first$/ },
  ];
  let currentRoot = '';
  for (const row of rows) {
    const r = scratch();
    currentRoot = r.dir;
    try {
      seedBacklog(r.dir);
      const d = await readyGoal(r.dir, 'g1', row.flags ?? [], row.body ?? MILESTONE_DRAFT);
      await row.arrange?.(r.dir);
      const config = structuredClone(loadConfig(r.dir).config);
      row.config?.(config);
      const before = snapshot(r.dir);
      const gate = gateOf(r.dir, config);
      const pins = row.pins?.(d) ?? {};
      const after = row.pins ? snapshot(r.dir) : before;
      const tracker = row.tracker ? async () => row.tracker!(r.dir, config) : () => loadTracker(r.dir, config);
      await assert.rejects(approve(r.dir, config, tracker, pins), (e: unknown) => {
        assert.ok(e instanceof ForgeError, `${row.name}: ${e}`);
        assert.match(e.message, row.want, row.name);
        assert.equal(e.exitCode, 1, row.name);
        if (row.code) assert.equal(e.code, row.code, row.name);
        return true;
      });
      assert.deepEqual(snapshot(r.dir), after, `${row.name}: nothing written`);
      assert.equal(gateOf(r.dir, config), gate, `${row.name}: the gate stays ${gate}`);
      assert.equal(fs.existsSync(filingFile(r.dir, 'g1')), false, `${row.name}: no filing record`);
    } finally {
      r.cleanup();
    }
  }
});

test('filing resumes where it stopped', async () => {
  const r = scratch();
  try {
    seedBacklog(r.dir);
    await readyGoal(r.dir, 'g1');
    const { config } = loadConfig(r.dir);
    // The second new issue (brief, issues[2]) fails.
    const failing = counting((n, item) => {
      if (n === 2) throw new ForgeError('gh: HTTP 502', 'external');
      return local.create({ root: r.dir, config }, item);
    });
    await assert.rejects(approve(r.dir, config, async () => failing.tracker), (e: unknown) => {
      assert.ok(e instanceof ForgeError);
      assert.equal(e.message, 'filing stopped at issues[2]: gh: HTTP 502; run forge mandate draft approve g1 again to finish');
      assert.equal(e.exitCode, 5, "the tracker's own code");
      return true;
    });
    const rec = readFiling(r.dir, 'g1');
    assert.ok(rec && !('problem' in rec), JSON.stringify(rec));
    assert.deepEqual([rec.milestone.ref, rec.issues.lens.ref, rec.issues.reuse.action, rec.issues.brief.ref, rec.error], ['Fewer review rounds', 'sharper-code-lens', 'reused', null, 'gh: HTTP 502']);
    assert.match(rec.digest, /^[0-9a-f]{64}$/);
    assert.equal(gateOf(r.dir, config), 'filing');

    const working = counting();
    const out = await approve(r.dir, config, async () => working.tracker);
    assert.deepEqual([working.calls.createMilestone, working.calls.create, working.calls.milestoneAdd], [undefined, 1, undefined], JSON.stringify(working.calls));
    assert.ok(out.decision === 'approve' && out.filing.completedAt);
    assert.equal(gateOf(r.dir, config), 'filed');
    assert.equal(fs.readFileSync(backlog(r.dir), 'utf8').split('\n').filter((l) => l === '- [ ] Sharper code lens').length, 1, 'filed once');
  } finally {
    r.cleanup();
  }

  // A crash after the tracker created the item but before the record took its ref: the retry adopts it.
  const a = scratch();
  try {
    seedBacklog(a.dir);
    await readyGoal(a.dir, 'g1');
    const { config } = loadConfig(a.dir);
    const crashing = counting((n, item) => {
      local.create({ root: a.dir, config }, item);
      if (n === 2) throw new Error('killed');
      return { ref: 'sharper-code-lens', url: null };
    });
    await assert.rejects(approve(a.dir, config, async () => crashing.tracker), /filing stopped at issues\[2\]: killed/);
    const working = counting();
    const out = await approve(a.dir, config, async () => working.tracker);
    assert.equal(working.calls.create, undefined, 'adopted, not created again');
    assert.ok(out.decision === 'approve');
    assert.equal(out.decision === 'approve' && out.filing.issues.find((i) => i.key === 'brief')?.ref, 'builder-brief-names-nits');

    // Once filed, every decision is refused.
    await assert.rejects(approve(a.dir, config, async () => working.tracker), /mandate g1's draft is filed$/);
  } finally {
    a.cleanup();
  }

  // The draft's bytes changed after approval: nothing files, no tracker call.
  const b = scratch();
  try {
    seedBacklog(b.dir);
    await readyGoal(b.dir, 'g1');
    const { config } = loadConfig(b.dir);
    const failing = counting(() => {
      throw new Error('down');
    });
    await assert.rejects(approve(b.dir, config, async () => failing.tracker), /filing stopped/);
    fs.writeFileSync(draftJson(b.dir, 'g1'), JSON.stringify(JSON.parse(fs.readFileSync(draftJson(b.dir, 'g1'), 'utf8'))));
    const watched = counting();
    await assert.rejects(approve(b.dir, config, async () => watched.tracker), /the draft changed after approval \(filing\.json has [0-9a-f]{12}, draft\.json is [0-9a-f]{12}\); a person checks the tracker/);
    assert.deepEqual(watched.calls, {}, 'no tracker call');

    const lock = path.join(paths(b.dir).locks, 'mandate-decide-g1');
    await withLockAsync(lock, async () => {
      await assert.rejects(approve(b.dir, config, async () => watched.tracker), /a decision on mandate g1 is already running$/);
    });
  } finally {
    b.cleanup();
  }
});

test('the guarded tracker scans milestone text', async () => {
  const r = scratch();
  const own = local.createMilestone;
  let called = 0;
  try {
    local.createMilestone = (...args) => (called++, own(...args));
    const { config } = loadConfig(r.dir);
    const tracker = await loadTracker(r.dir, config);
    assert.throws(
      () => tracker.createMilestone!({ root: r.dir, config }, { title: 'M1', description: `key ${ACCESS_KEY}` }),
      (e: unknown) => e instanceof ForgeError && e.code === 'secret_found',
    );
    assert.throws(() => tracker.milestoneAdd!({ root: r.dir, config }, 'x', { milestone: `M ${ACCESS_KEY}`, labels: [] }), (e: unknown) => e instanceof ForgeError && e.code === 'secret_found');
    assert.equal(called, 0, "the adapter's own method never ran");
    tracker.createMilestone!({ root: r.dir, config }, { title: 'M1', description: 'fine' });
    assert.equal(called, 1);
  } finally {
    local.createMilestone = own;
    r.cleanup();
  }
});
