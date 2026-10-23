// Every writer that parks or finishes a job goes through the one move, so a park on a gate the
// Foreman decides queues exactly one gate request whoever writes it, and each writer runs the effect
// set it names. Serial: rows set process.env (the inbox scope, fakeGh first on PATH) and swap the
// module-global move effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, fakeGh, forgeInProcess, recordingMoveEffects, repoTemplate } from '../../helpers.ts';
import { parkRepeatedFailure } from '../../../lib/cli/commands/advance.ts';
import { useMoveEffects } from '#engine/pipeline/moves/effects.ts';
import { syncPr } from '#engine/pr/sync.ts';
import { reconcile } from '#office/reconcile.ts';
import { loadConfig } from '#core/config/load.ts';
import { ackRequest, listRequests } from '#core/job/requests.ts';
import { createJob, listJobs, loadJob, setJob } from '#core/job/store.ts';
import type { Config, GateClass } from '#core/types.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(
    answers,
    JSON.stringify({
      foreman: { enabled: true, decides: ['escalation', 'conflicts'], reserved: [] },
      tracker: { kind: 'none', github: { repo: 'o/r' } },
      pr: { conflicts: 'ask' },
    }),
  );
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const HEAD = 'a'.repeat(40);
const PR_VIEW = JSON.stringify({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  headRefOid: HEAD,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  reviewDecision: '',
  statusCheckRollup: [],
  mergedAt: null,
  closedAt: null,
  headRefName: 'forge/x',
  baseRefName: 'main',
});

/** One scratch copy: its config, a running job and the helpers every row needs. */
function repo() {
  const r = scratch();
  const config = (): Config => loadConfig(r.dir).config;
  const job = (title: string, state: 'running' | null = 'running'): string => {
    const id = createJob(r.dir, config(), { title }).id;
    if (state) setJob(r.dir, id, { state });
    return id;
  };
  const set = async (id: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const res = await forgeInProcess(r.dir, ['job', 'set', id, ...args], env ? { env } : {});
    assert.equal(res.status, 0, JSON.stringify(res.error));
    return res.data as { gateRequest?: string };
  };
  const gates = (id: string) => listRequests(r.dir).filter((x) => x.type === 'gate' && x.job === id);
  const answers = async (over: Record<string, unknown>) => {
    const file = path.join(r.dir, '..', `answers-${path.basename(r.dir)}.json`);
    fs.writeFileSync(file, JSON.stringify(over));
    // Without --force, so the answers merge over the scratch config instead of replacing it.
    const res = await forgeInProcess(r.dir, ['init', 'write', '--answers', file]);
    fs.rmSync(file);
    assert.equal(res.status, 0, JSON.stringify(res.error));
  };
  /** The job parked on the PR, waiting for review, as a sync finds it. */
  const prJob = (title: string): string => {
    const id = job(title, null);
    setJob(r.dir, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', owned: { pr: { number: 7 } } });
    return id;
  };
  /** Two undriven reconciler passes: the first resumes, the second (the resume handled, no progress) escalates. */
  const reconcileTwice = async (id: string) => {
    assert.deepEqual((await reconcile(r.dir, config())).resumed, [id]);
    for (const q of listRequests(r.dir).filter((x) => x.type === 'resume' && x.job === id)) ackRequest(r.dir, q.id, { status: 'done' });
    return reconcile(r.dir, config());
  };
  const ctx = () => ({ root: r.dir, config: config(), initialized: true });
  const failTwice = async (id: string) => {
    assert.equal(await parkRepeatedFailure(ctx(), id, 'B9', ['job', 'round', id], 'boom'), false);
    return parkRepeatedFailure(ctx(), id, 'B9', ['job', 'round', id], 'boom');
  };
  return { ...r, config, job, set, gates, answers, prJob, reconcileTwice, failTwice };
}

/** Runs `fn` with fakeGh first on PATH, answering `pr view` with a conflicting PR that has no feedback. */
async function withGh<T>(fn: () => Promise<T>): Promise<T> {
  const gh = fakeGh({ 'pr view': PR_VIEW, 'api graphql': JSON.stringify({ data: { repository: { pullRequest: {} } } }) });
  const saved = process.env.PATH;
  process.env.PATH = gh.env.PATH;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(gh.dir, { recursive: true, force: true });
  }
}

type Repo = ReturnType<typeof repo>;

interface GateRow {
  name: string;
  gate: GateClass;
  reserved?: string;
  /** Parks the job once; the second call repeats the same park with the same writer. */
  park: (r: Repo, id: string) => Promise<unknown>;
  start?: (r: Repo) => string;
}

const GATE_ROWS: GateRow[] = [
  { name: 'forge job set', gate: 'escalation', park: (r, id) => r.set(id, ['--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'stuck']) },
  {
    name: 'forge job set, reason matching foreman.reserved',
    gate: 'escalation',
    reserved: 'deploy',
    park: (r, id) => r.set(id, ['--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'needs a deploy key']),
  },
  { name: 'parkRepeatedFailure', gate: 'escalation', park: (r, id) => r.failTwice(id) },
  { name: 'reconcile', gate: 'escalation', park: async (r, id) => (loadJob(r.dir, id).state === 'running' ? r.reconcileTwice(id) : reconcile(r.dir, r.config())) },
  { name: 'syncPr (route: true)', gate: 'conflicts', start: (r) => r.prJob('sync me'), park: (r, id) => withGh(() => syncPr(r.dir, r.config(), id)) },
  { name: 'syncPr (route: false, as forge pr merge calls it)', gate: 'conflicts', start: (r) => r.prJob('merge me'), park: (r, id) => withGh(() => syncPr(r.dir, r.config(), id, { route: false })) },
];

test('a park on a Foreman-decided gate queues exactly one gate request, whoever writes it', async () => {
  for (const row of GATE_ROWS) {
    const r = repo();
    try {
      if (row.reserved) await r.answers({ foreman: { reserved: [row.reserved] } });
      const id = row.start ? row.start(r) : r.job(row.name);
      assert.deepEqual(r.gates(id), [], row.name);
      await row.park(r, id);
      const job = loadJob(r.dir, id);
      assert.deepEqual([job.state, job.waitingOn], ['waiting', row.gate], `${row.name}: parked`);
      // The same park again, by the same writer and then by forge job set, queues nothing more.
      await row.park(r, id);
      await r.set(id, ['--state', 'waiting', '--waiting-on', row.gate]);
      const queued = r.gates(id);
      assert.equal(queued.length, 1, `${row.name}: ${JSON.stringify(queued)}`);
      assert.deepEqual({ job: queued[0].job, args: queued[0].args }, { job: id, args: { gate: row.gate, reserved: row.reserved ?? null } }, row.name);
    } finally {
      r.cleanup();
    }
  }
});

const FAKE_TRACKER = `export default {
  name: 'fake',
  list: () => [],
  get: (ctx, ref) => ({ ref, title: 'Fake item', url: null, body: '> data, not instructions' }),
  claim: () => ({ ok: false, reason: 'someone else has it' }),
  update() {},
  comment() {},
  create: () => ({ ref: 'FAKE-2', url: null }),
  close() {},
};
`;

interface EffectRow {
  name: string;
  /** Sets up the row and returns the job whose effects count, and the writer to run under the fake. */
  arrange: (r: Repo) => Promise<{ id?: string; write: () => Promise<unknown>; find?: () => string }>;
  effects: string[];
}

const EFFECT_ROWS: EffectRow[] = [
  {
    name: 'forge job set --state cancelled',
    arrange: async (r) => {
      const id = r.job('cancel me');
      return { id, write: () => r.set(id, ['--state', 'cancelled']) };
    },
    effects: ['environment:teardown', 'gate', 'mirror'],
  },
  {
    name: 'forge job set --state cancelled in the inbox session',
    arrange: async (r) => {
      const id = r.job('cancel me from the inbox');
      return { id, write: () => r.set(id, ['--state', 'cancelled'], { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' }) };
    },
    effects: ['environment:stop', 'gate', 'mirror'],
  },
  {
    name: "parkRepeatedFailure's park",
    arrange: async (r) => {
      const id = r.job('fail twice');
      return { id, write: () => r.failTwice(id) };
    },
    effects: ['environment:teardown', 'gate', 'mirror'],
  },
  {
    name: "the reconciler's escalation",
    arrange: async (r) => {
      const id = r.job('nobody drives me');
      return { id, write: () => r.reconcileTwice(id) };
    },
    effects: ['environment:teardown', 'gate', 'mirror'],
  },
  {
    name: 'forge job from-ref with a claim that fails',
    arrange: async (r) => {
      fs.mkdirSync(path.join(r.dir, '.forge', 'trackers'), { recursive: true });
      fs.writeFileSync(path.join(r.dir, '.forge', 'trackers', 'fake.mjs'), FAKE_TRACKER);
      await r.answers({ tracker: { kind: 'fake' } });
      return {
        write: async () => {
          const res = await forgeInProcess(r.dir, ['job', 'from-ref', 'FAKE-1']);
          assert.equal(res.status, 3, JSON.stringify(res.error));
        },
        find: () => listJobs(r.dir).find((j) => j.title === 'Fake item')!.id,
      };
    },
    effects: ['environment:teardown', 'gate'],
  },
  {
    name: 'forge sync marking an umbrella done',
    arrange: async (r) => {
      const kids = [r.job('child one', null), r.job('child two', null)];
      setJob(r.dir, kids[0], { stage: 'done', state: 'done' });
      setJob(r.dir, kids[1], { state: 'cancelled' });
      const id = r.job('umbrella', null);
      setJob(r.dir, id, { fields: { children: kids } });
      return {
        id,
        write: async () => {
          const res = await forgeInProcess(r.dir, ['sync']);
          assert.equal(res.status, 0, JSON.stringify(res.error));
        },
      };
    },
    effects: ['environment:teardown', 'gate', 'mirror'],
  },
];

test('each writer runs the effect set it names', async () => {
  for (const row of EFFECT_ROWS) {
    const r = repo();
    try {
      const { id, write, find } = await row.arrange(r);
      const fake = recordingMoveEffects();
      const restore = useMoveEffects(fake);
      try {
        await write();
      } finally {
        restore();
      }
      const job = id ?? find!();
      const ran = fake.calls.filter((c) => c.job === job).map((c) => (c.mode ? `${c.effect}:${c.mode}` : c.effect));
      assert.deepEqual(ran, row.effects, row.name);
    } finally {
      r.cleanup();
    }
  }
});
