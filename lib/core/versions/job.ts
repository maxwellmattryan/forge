// The job version steps: job.json's schemaVersion is this list's length plus one, with the helpers
// the steps need. Append only (AGENTS.md here): a new step goes at the end, with a row keyed by its id
// in test/schema.test.ts.
import { isStoredRef } from '../job/issue-ref.ts';
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';
import type { JobLease } from '../types.ts';

export const JOB_STEPS: readonly Step[] = [
  // v1 kept one PASS/FAIL per round; v2 keeps every attempt with the sha it ran against.
  { id: 'verify-runs', up: (j) => ({
    ...j,
    verifyRuns: j.verifyRuns ?? Object.entries(j.verify ?? {}).map(([round, v]) => ({ round: Number(round), attempt: 1, sha: null, ok: v === 'PASS', at: null, file: `verify/round-${round}.md` })),
  }) },
  // v3 adds per-job budgets and per-round failed-verify counts, recovered from the run history.
  { id: 'budgets-and-verify-retries', up: (j) => ({
    ...j,
    verifyRetries: j.verifyRetries ?? failedVerifiesByRound(j.verifyRuns ?? []),
    budget: j.budget ?? { limits: {}, ack: {}, lastCheck: null },
  }) },
  // v4 adds the human's "this job needs no issue" override (forge job link --none).
  { id: 'no-issue', up: (j) => ({ ...j, noIssue: j.noIssue ?? null }) },
  // v5 adds each agent record's import cursor. An ended agent's usage is already recorded and its
  // transcript ends before its endedAt, so that is a safe cursor: resuming it counts only new work.
  { id: 'agent-import-cursor', up: (j) => ({
    ...j,
    agents: Object.fromEntries(
      Object.entries(j.agents ?? {}).map(([role, a]: [string, any]) => [
        role,
        a && !a.importedThrough && a.agentId && a.endedAt ? { ...a, importedThrough: { [a.agentId]: a.endedAt } } : a,
      ]),
    ),
  }) },
  // v6 records whether a job's planner must never split it (from-ref, revise-split). A v5 job did
  // not record how it started, so it is not backfilled to "never": it keeps pipeline.split.
  { id: 'split-mode', up: (j) => ({ ...j, splitMode: j.splitMode ?? null }) },
  // v7 adds the human's per-job reasoning effort. null inherits runtime.effort, which is what every
  // v6 job ran at, so the upgrade changes no job's effort.
  { id: 'job-effort', up: (j) => ({ ...j, effort: j.effort ?? null }) },
  // v8 adds `waitingOn: human` (a CLI check, such as the secret scan, stopped the job). No v7 job
  // waits on it, so nothing changes; the bump makes an older Forge refuse a job parked on a gate it
  // can't explain.
  { id: 'human-gate', up: (j) => j },
  // v9 adds the spec's judged complexity, recorded when the spec is. A v8 job never had one.
  { id: 'complexity', up: (j) => ({ ...j, complexity: j.complexity ?? null }) },
  // v10 adds the protected-paths flag the CLI records. A v9 job has none; pr open recomputes anyway.
  { id: 'protected-paths', up: (j) => ({ ...j, protectedPaths: j.protectedPaths ?? null }) },
  // v11 gives a job a list of issues instead of one `source`, so a job can carry issues from several
  // repos and an issue can sit on several jobs. A GitHub source whose url names its repo is
  // qualified (`owner/repo#12`); one without stays a bare number, which still reads as this repo.
  { id: 'issues-list', up: (j) => {
    const { source, ...rest } = j;
    return { ...rest, issues: j.issues ?? sourceToIssues(source) };
  } },
  // v12 lets a job change member repos too: `repos[0]` mirrors the root repo's top-level fields
  // (normalizeJob rebuilds it), so a v11 job becomes a one-repo job and nothing it did changes.
  { id: 'member-repos', up: (j) => ({ ...j, repos: Array.isArray(j.repos) ? j.repos : [] }) },
  // v13 adds the human's per-job interim strategy override (forge job repo interim): null inherits
  // config, which is what every v12 job did. Members get theirs in cleanRepos.
  { id: 'interim-override', up: (j) => ({ ...j, interim: j.interim ?? null }) },
  // v14 adds one port per port-bearing component. A v13 job keeps its `port`, which the next
  // `worktree create` reconciles into `ports` (lib/engine/environment/ports.ts), so nothing it runs changes.
  { id: 'component-ports', up: (j) => ({ ...j, ports: {} }) },
  // v15 adds the merged PR's post-merge outcome, which forge sync measures. A v14 job has none yet,
  // and the next sync measures it, so a long-merged job gets a final outcome straight away.
  { id: 'outcome', up: (j) => ({ ...j, outcome: j.outcome ?? null }) },
  // v16 adds the post-merge score (lib/engine/evals/scoring.ts). A v15 job has none; the next sync queues one
  // only when the job is sampled and merged inside the lookback.
  { id: 'score', up: (j) => ({ ...j, score: j.score ?? null }) },
  // v17 replaces the heartbeat `owner` with a fenced `lease`. A v16 owner keeps driving: it becomes
  // epoch 1, renewed at its heartbeat and live for the 30 minutes the heartbeat rule gave it.
  { id: 'lease', up: (j) => {
    const { owner, ...rest } = j;
    return { ...rest, lease: j.lease ?? ownerToLease(owner) };
  } },
  // v18 adds the mandate a job works under. No v17 job is in one, so the Foreman's gates for it stay as they were.
  { id: 'job-mandate', up: (j) => ({ ...j, mandate: j.mandate ?? null }) },
  // v19 adds the human's per-job merge mode. null inherits merge.auto, which is what every v18 job
  // followed, so the upgrade changes no job's merge.
  { id: 'job-merge-mode', up: (j) => ({ ...j, mergeMode: j.mergeMode ?? null }) },
];

export const JOB_SCHEMA_VERSION = versionOf(JOB_STEPS);

/** No driver, epoch 0: a new job's lease. */
export const noLease = (): JobLease => ({ driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });

/** A v16 `{ session, host, since, heartbeat }` owner as a lease. Frozen at v16's 30-minute rule, whatever LEASE_MS becomes. */
export function ownerToLease(owner: any): JobLease {
  if (!owner || typeof owner !== 'object' || typeof owner.session !== 'string' || !owner.session) return noLease();
  const renewedAt = typeof owner.heartbeat === 'string' ? owner.heartbeat : typeof owner.since === 'string' ? owner.since : null;
  const t = renewedAt ? Date.parse(renewedAt) : NaN;
  // An unparseable heartbeat keeps the driver but reads as expired.
  return { driver: owner.session, epoch: 1, since: typeof owner.since === 'string' ? owner.since : null, renewedAt, expiresAt: Number.isFinite(t) ? new Date(t + 30 * 60_000).toISOString() : null };
}

const ISSUE_URL = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/(\d{1,10})$/;

/** A v10 `source` as the v11 list: one entry, or none for a null source. */
export function sourceToIssues(source: unknown): unknown[] {
  if (!source || typeof source !== 'object') return [];
  const s = source as { tracker?: unknown; ref?: unknown; url?: unknown };
  let ref = typeof s.ref === 'number' ? String(s.ref) : s.ref ?? null;
  const url = s.url ?? null;
  if (s.tracker === 'github' && typeof ref === 'string' && /^\d+$/.test(ref) && typeof url === 'string') {
    const m = ISSUE_URL.exec(url);
    if (m && m[3] === ref && !m[1].includes('..') && !m[2].includes('..')) ref = `${m[1]}/${m[2]}#${ref}`;
  }
  // `forge job new --ref` stored refs unchecked before v11, so an old ref may fail the grammar
  // (`ends done`). Dropping it would unlink the job and park it again at the issue-link gate, so it
  // is kept in the nearest form the grammar accepts.
  if (typeof ref === 'string' && typeof s.tracker === 'string' && !isStoredRef(ref, s.tracker)) ref = legacyRef(ref, s.tracker);
  return [{ tracker: s.tracker, ref, url }];
}

function legacyRef(raw: string, tracker: string): string | null {
  const ref = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100).replace(/[-.]+$/, '');
  return isStoredRef(ref, tracker) ? ref : null;
}

function failedVerifiesByRound(runs: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) if (r && r.ok === false) out[String(r.round)] = (out[String(r.round)] ?? 0) + 1;
  return out;
}
