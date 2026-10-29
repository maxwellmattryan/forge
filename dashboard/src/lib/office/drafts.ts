// A goal mandate's milestone draft as the Needs-you card shows it: its issues by wave, the actions its gate
// offers, and the GET and POST of /api/mandates/:id/draft (lib/server/routes/mandates.ts). Every POST carries
// the request and digest of the draft the card rendered, so the server decides exactly what was shown.
// Plain TS, so a test can pin it.
import { projectApi } from '../core/project.ts';
import { api } from '../core/util.ts';
import type { DraftGate, DraftIssue, MandateDraftResponse, MilestoneDraft, PostMandateDraftBody, PostMandateDraftResponse } from '../core/types.ts';

/** The draft's issues grouped by wave, ascending, each wave in draft order. */
export function wavesOf(draft: Pick<MilestoneDraft, 'issues'>): { wave: number; issues: DraftIssue[] }[] {
  const byWave = new Map<number, DraftIssue[]>();
  for (const it of draft.issues) byWave.set(it.wave, [...(byWave.get(it.wave) ?? []), it]);
  return [...byWave.entries()].sort((a, b) => a[0] - b[0]).map(([wave, issues]) => ({ wave, issues }));
}

export type DraftCardAction = 'approve' | 'revise' | 'reject' | 'retry';

/** What the card offers: a pending draft is approved, revised or rejected; a stopped filing is only retried. */
export const draftCardActions = (status: DraftGate['status']): DraftCardAction[] => (status === 'filing' ? ['retry'] : ['approve', 'revise', 'reject']);

/** The POST body, exactly: the decision, the request and digest the card read, and the note (null when empty). */
export function draftDecisionBody(decision: PostMandateDraftBody['decision'], request: string, digest: string, note: string): PostMandateDraftBody {
  return { decision, request, digest, note: note.trim() ? note.trim() : null };
}

const draftPath = (id: string): string => `/api/mandates/${encodeURIComponent(id)}/draft`;

/** GET /api/mandates/:id/draft. */
export const fetchDraft = (id: string): Promise<MandateDraftResponse> => api<MandateDraftResponse>(draftPath(id));

/** POST /api/mandates/:id/draft; throws with the server's `error`. */
export async function postDraftDecision(id: string, body: PostMandateDraftBody, fetchImpl: typeof fetch = fetch): Promise<PostMandateDraftResponse> {
  const res = await fetchImpl(projectApi(draftPath(id)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
  if (!res.ok) throw new Error(error || raw || res.statusText);
  return parsed as PostMandateDraftResponse;
}
