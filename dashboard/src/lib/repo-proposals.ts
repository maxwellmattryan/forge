// A job's repo proposals as the dashboard shows them: the RP1 park (lib/step/gates.ts) that tells this `human` wait
// apart, the rows of repo-proposals.json (agent-written job state, so parsed defensively and rendered as text),
// and the POST that decides them (lib/server.ts). Plain TS, so test/dashboard-repo-proposals.test.ts can pin it.
import type { Job, PostJobReposBody, PostJobReposResponse, RepoProposal } from './types.ts';

/** RP1's reason prefix, as lib/repo-proposals.ts PARK_PREFIX. */
export const REPO_PROPOSAL_PREFIX = 'repo proposal:';
/** lib/member-repos.ts REPO_NAME: a row whose repo fails it is dropped. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REASON_MAX = 200;
const NOTE_MAX = 2000;
const MAX_ROWS = 50;
const STATUSES: readonly RepoProposal['status'][] = ['pending', 'approved', 'rejected'];

/** The job waits on the repo proposal park: `human`, with RP1's reason. */
export const isRepoProposal = (job: Partial<Pick<Job, 'state' | 'waitingOn' | 'reason'>> | null | undefined): boolean =>
  Boolean(job && job.state === 'waiting' && job.waitingOn === 'human' && String(job.reason ?? '').startsWith(REPO_PROPOSAL_PREFIX));

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** repo-proposals.json's rows; anything malformed is dropped, never thrown on. */
export function parseRepoProposals(raw: string): RepoProposal[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = doc && typeof doc === 'object' && Array.isArray((doc as { proposals?: unknown }).proposals) ? (doc as { proposals: unknown[] }).proposals : [];
  const rows: RepoProposal[] = [];
  for (const r of list.slice(0, MAX_ROWS)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.repo !== 'string' || !REPO_NAME.test(o.repo) || !(STATUSES as readonly unknown[]).includes(o.status)) continue;
    rows.push({
      repo: o.repo,
      reason: text(o.reason, REASON_MAX) ?? '',
      proposedAt: text(o.proposedAt, 40) ?? '',
      status: o.status as RepoProposal['status'],
      decidedAt: text(o.decidedAt, 40),
      // Who decided is shown from the job's events (the drawer), never from this agent-writable file.
      actor: null,
      note: text(o.note, NOTE_MAX),
    });
  }
  return rows;
}

/** The pending repos among the rows the drawer lists: what Approve and Reject name, and nothing else. */
export const pendingRepos = (rows: RepoProposal[]): string[] => rows.filter((r) => r.status === 'pending').map((r) => r.repo);

/**
 * POST /api/jobs/:id/repos with the repos the drawer listed; throws with the server's `error`. The server
 * answers 409 unless they are the whole pending set from the job's events, so a repo the edited file hid,
 * or one proposed since the list loaded, is never decided unseen.
 */
export async function postRepoDecision(id: string, decision: PostJobReposBody['decision'], repos: string[], note: string, token: string, fetchImpl: typeof fetch = fetch): Promise<PostJobReposResponse> {
  const body: PostJobReposBody = { decision, repos, note: note.trim() ? note.trim() : null };
  const res = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}/repos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-token': token }, body: JSON.stringify(body) });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
  if (!res.ok) throw new Error(error || raw || res.statusText);
  return parsed as PostJobReposResponse;
}

/** A row's status chip tone: pending waits on someone (ember), approved is ok, rejected is muted. */
export const proposalTone = (status: RepoProposal['status']): 'you' | 'ok' | 'muted' => (status === 'pending' ? 'you' : status === 'approved' ? 'ok' : 'muted');
