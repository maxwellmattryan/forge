// The rules for the job fields setJob writes: which keys are locked to their owning command, which
// lists must hold strings, and which values `complexity` and `kind` may take. setJob enforces them
// for every caller (`forge job set`, the dashboard, any module), so a locked key can't be reached
// by going around the CLI. Kept apart from jobs.ts and schema.ts, which are both past 600 lines.
import { COMPLEXITIES } from './schema.ts';
import { hasProtoSegment } from '../shape.ts';
import type { Job } from '../types.ts';
import { ForgeError } from '../errors.ts';

// List fields `step`, the briefs and the dashboard iterate; each maps to the example its error shows.
export const ARRAY_FIELDS: Record<string, string> = { reviewers: '["code","tests"]', services: '["api"]', dependsOn: '["<job id>"]', children: '["<job id>"]' };

// A job's identity: what it pushes to, where it lives and who owns it. A session misled by request
// text could otherwise run `--field branch=main` and have `forge pr open` push there, so only the
// command that owns each key may write it. Each maps to that command, for the error.
export const LOCKED_FIELDS: Record<string, string> = {
  id: 'forge job new',
  createdAt: 'forge job new',
  branch: 'forge job new --branch',
  base: 'forge worktree create or forge sync',
  worktree: 'forge worktree create|remove',
  port: 'forge worktree create|remove',
  owner: 'forge job claim|release',
  lease: 'forge job claim|release',
  runs: 'forge job claim|release',
  source: 'forge job link',
  issues: 'forge job link',
  // A waiver set by hand would let a job past the issue-link wait with nobody having decided it.
  noIssue: 'forge job link --none',
  pr: 'forge pr find|open|sync',
  schemaVersion: 'forge migrate',
  usage: 'forge job agent',
  // A run's start and end times decide when the approver's decision is recorded (once per run).
  agents: 'forge job agent',
  effort: 'forge job effort',
  // An `auto` set by a session would let agents merge a job a person kept for themselves.
  mergeMode: 'forge job merge-mode',
  // Leaving a mandate would widen what the Foreman decides for the job; a split child keeps its parent's.
  mandate: 'forge job new --mandate',
  // A cleared flag would skip the PP1 park; pr open recomputes it anyway.
  protectedPaths: 'forge git add|commit, forge verify or forge pr open',
  eval: 'forge eval start',
  // Which repos a job pushes to is a human decision.
  repos: 'forge job repo add|remove',
  // What its PRs point at, and what may be published, is too.
  interim: 'forge job repo interim',
  // A hand-set `queued` score would spend a judge run nobody sampled.
  score: 'forge sync or forge job score record',
  // A session could otherwise null its own spend caps; only a person raises or acknowledges them.
  budget: "forge job budget or the dashboard's Approve on the budget gate",
};

// Kinds step routes differently: a retro job's review panel is fixed at code and docs, and an eval
// job skips the PR and the escalation gate. A session set to `retro` mid-build would have RV9 drop
// the lenses its diff selected, so only the command that creates each kind writes it.
export const OWNED_KINDS: Record<string, string> = {
  retro: 'forge job new --kind retro',
  eval: 'forge eval start',
};

const protoMessage = (key: string): string => `--field ${key}: __proto__, constructor and prototype are not field names`;

/** Throws when a `fields` key has a prototype segment (setPath would walk it into Object.prototype) or sits under a locked field. */
export function checkFieldKey(key: string): void {
  if (hasProtoSegment(key)) throw new ForgeError(protoMessage(key));
  const top = key.split('.')[0];
  if (Object.hasOwn(LOCKED_FIELDS, top)) throw new ForgeError(`--field ${top} is not settable; use ${LOCKED_FIELDS[top]}`);
}

/** Throws the first rule `fields` breaks for `job`, with `forge job set`'s message, before anything is written. */
export function checkJobFields(fields: Record<string, unknown>, job: Pick<Job, 'id' | 'kind'>): void {
  for (const key of Object.keys(fields)) checkFieldKey(key);
  // Every rule below keys on a path's first segment, because setPath walks `reviewers.0` into the list
  // and `kind.x` over the string: a nested key must not get past a rule meant for the whole value.
  for (const key of Object.keys(fields)) {
    const top = key.split('.')[0];
    if (!Object.hasOwn(ARRAY_FIELDS, top)) continue;
    const v = fields[key];
    if (key !== top || !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new ForgeError(`--field ${top} must be a JSON array of strings, e.g. --field '${top}=${ARRAY_FIELDS[top]}'`);
  }
  // complexity picks among levels a human configured, so only the three values (or none) are accepted.
  for (const key of Object.keys(fields))
    if (key.split('.')[0] === 'complexity' && (key !== 'complexity' || !(fields[key] === null || (COMPLEXITIES as readonly unknown[]).includes(fields[key]))))
      throw new ForgeError('--field complexity must be low, medium or high, or null');
  const kindKeys = Object.keys(fields).filter((key) => key.split('.')[0] === 'kind');
  if (kindKeys.length > 0) {
    if (Object.hasOwn(fields, 'kind') && Object.hasOwn(OWNED_KINDS, String(fields.kind))) throw new ForgeError(`--field kind=${fields.kind} is not settable; use ${OWNED_KINDS[String(fields.kind)]}`);
    // Nor the other way: a retro set to `feature` would hand its spec gate to the foreman.
    if (Object.hasOwn(OWNED_KINDS, String(job.kind))) throw new ForgeError(`job ${job.id} is a ${job.kind} job; its kind is not settable`);
    const nested = kindKeys.find((key) => key !== 'kind');
    if (nested !== undefined) throw new ForgeError(`--field ${nested} is not settable; kind is one value, set it with --field kind=<kind>`);
  }
}

/** Throws unless every `owned` key sits under a locked field: `owned` is for the module that owns it, never a way past checkJobFields. */
export function checkOwnedFields(owned: Record<string, unknown>): void {
  for (const key of Object.keys(owned)) {
    if (hasProtoSegment(key)) throw new ForgeError(protoMessage(key));
    if (!Object.hasOwn(LOCKED_FIELDS, key.split('.')[0])) throw new ForgeError(`owned field ${key} is not a locked field; write it through fields`, 'internal');
  }
}
