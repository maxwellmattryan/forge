// The rows that run before any stage: finished jobs, parks, running agents, lost runs, and the
// retro kind's own start.
import type { WaitingOn } from '#core/types.ts';
import type { StepInput } from '../types.ts';
import { SAFE_REF } from '#core/text.ts';
import { SAFE_URL, done, procedure, run, safe, spawn, toStage, wait } from './actions.ts';
import { ANSWERED } from './answered.ts';
import { after, agent, ended, parkedRunning, pendingVerifiers, runningRoles } from './facts.ts';
import type { Facts } from './facts.ts';
import { gateTell, prReviewTell } from './gates.ts';
import type { Ctx, Table } from './rules.ts';
import { nextLenses, retryLens } from './stages/review.ts';

/** The role whose lost or failed run blocks the current stage (L1); reviewers go through M1/M2 instead. */
function blockedRole(x: StepInput, f: Facts): string | null {
  const j = x.job;
  const a = (r: string) => agent(x, r);
  const latest = (roles: string[]) => roles.filter((r) => a(r)?.startedAt).sort((m, n) => String(a(n)!.startedAt).localeCompare(String(a(m)!.startedAt)))[0] ?? null;
  let role: string | null = null;
  switch (j.stage) {
    case 'plan':
      role = 'planner';
      break;
    case 'spec':
      role = a('spec-writer') ? 'spec-writer' : null;
      break;
    case 'design':
      role = latest(['designer', 'spec-writer']);
      break;
    case 'build':
      role = a('builder')?.round === j.round ? 'builder' : null;
      break;
    case 'verify':
      role = pendingVerifiers(x) && after(a('verifier')?.startedAt, pendingVerifiers(x)!.ts) ? 'verifier' : null;
      break;
    case 'decide':
      role = latest(['approver', 'judge']);
      if (role === 'approver' && a('approver')?.round !== j.round) role = null;
      break;
    case 'integrate':
      role = after(a('integrator')?.startedAt, f.stageEntry?.ts) ? 'integrator' : null;
      break;
  }
  return role && ['lost', 'failed'].includes(String(a(role)?.status)) ? role : null;
}

/** A done job's queued post-merge score run (JS1–JS3). */
const scoreQueued = ({ x }: Ctx) => x.job.state === 'done' && x.job.kind !== 'eval' && x.job.score?.status === 'queued';
const prReview = ({ x }: Ctx) => x.job.state === 'waiting' && x.job.waitingOn === 'pr-review';
const parked = ({ x }: Ctx) => x.job.state === 'waiting' || x.job.state === 'blocked';
const gate = (x: StepInput): WaitingOn => (x.job.state === 'blocked' ? 'external' : (x.job.waitingOn ?? 'external'));

export const GLOBAL: Table = {
  name: 'global',
  applies: () => true,
  rules: [
    // Only a judge started after the queue counts, so an older judge record never stands in for it.
    { id: 'JS2', when: (c) => scoreQueued(c) && !after(agent(c.x, 'judge')?.startedAt, c.x.job.score?.queuedAt), then: ({ x }) => spawn(x, 'JS2', 'judge') },
    { id: 'JS1', when: (c) => scoreQueued(c) && agent(c.x, 'judge')?.status === 'running', then: ({ x }) => wait(x, 'JS1', 'agents') },
    // Recording makes the score terminal.
    { id: 'JS3', when: scoreQueued, then: ({ x }) => run(x, 'JS3', ['job', 'score', 'record', x.job.id], "record the judge's post-merge score") },
    {
      id: 'G1',
      when: ({ x }) => x.job.state === 'done' || x.job.state === 'cancelled' || x.job.stage === 'done',
      then: ({ x }) => {
        const j = x.job;
        const tell = j.state === 'cancelled' ? `${j.id} is cancelled` : j.pr?.url ? `${j.id} is done: ${safe(j.pr.url, SAFE_URL, `PR #${Number(j.pr.number) || '?'}`)}` : `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}`;
        return done(x, 'G1', tell);
      },
    },
    { id: 'G2', when: ({ x }) => x.job.state === 'failed', then: ({ x }) => done(x, 'G2', `${x.job.id} failed: ${x.job.reason ?? 'no reason recorded'}`) },
    // A park a logged decision answered moves on before any wait, environment stop or claim release.
    ...ANSWERED,
    { id: 'G3', when: (c) => prReview(c) && Boolean(c.x.job.lease.driver), then: ({ x }) => run(x, 'G3', ['job', 'release', x.job.id], 'the PR waits on human review; let the claim go') },
    { id: 'G3b', when: (c) => prReview(c) && parkedRunning(c.x), then: ({ x }) => run(x, 'G3b', ['environment', 'stop', x.job.id], 'stop the environment while the PR waits') },
    { id: 'G3c', when: prReview, then: ({ x }) => wait(x, 'G3c', 'pr-review', prReviewTell(x)) },
    { id: 'G4', when: (c) => parked(c) && parkedRunning(c.x), then: ({ x }) => run(x, 'G4', ['environment', 'stop', x.job.id], 'the job is parked: stop its environment') },
    { id: 'G4b', when: parked, then: ({ x }) => wait(x, 'G4b', gate(x), gateTell(x, gate(x))) },
    // Only a job whose environment Forge stopped: one never started has no entry and starts on demand.
    {
      id: 'E1',
      when: ({ x }) => x.job.state === 'running' && x.environment === 'stopped' && ['build', 'verify', 'review'].includes(x.job.stage),
      then: ({ x }) => run(x, 'E1', ['environment', 'up', x.job.id], 'a park stopped the environment', 'the job resumed: start its environment'),
    },
    // Review retries and first spawns go out while other reviewers run.
    { id: 'G5', when: ({ x }) => runningRoles(x).length > 0 && !(x.job.stage === 'review' && (nextLenses(x).length > 0 || retryLens(x) !== null)), then: ({ x }) => wait(x, 'G5', 'agents') },
    { id: 'L1', when: ({ x, f }) => blockedRole(x, f) !== null, then: ({ x, f }) => spawn(x, 'L1', blockedRole(x, f)!) },
  ],
};

/** A retro job starts with the retro agent, which writes spec.md. */
export const KIND: Table = {
  name: 'kind',
  applies: ({ x }) => x.job.kind === 'retro',
  rules: [
    { id: 'K1', when: ({ x }) => !ended(agent(x, 'retro')) || !x.files.spec, then: ({ x }) => procedure(x, 'K1', 'retro.md', 'a retro job starts with the retro agent') },
    { id: 'K2', when: ({ x }) => x.job.stage === 'backlog', then: ({ x }) => toStage(x, 'K2', 'spec', 'the retro wrote spec.md') },
  ],
};
