// A draft office run: `forge mandate draft prepare` as a CLI child, one forge:drafter model child on prepare's
// brief, model and effort whose only write root is the drafts dir, then `forge mandate draft record` with the
// drafter's session id as its agent id. The drafter's reply is never read, and neither is the survey, the
// staging file or the draft. docs/architecture/foreman.md › Office runs.
import { validEffort, validModel } from '#core/config/models.ts';
import { draftsDir } from '../../mandates/draft.ts';
import { OFFICE_AGENTS } from './child.ts';
import { RunFailed, type StepDeps, type StepEnd } from './steps.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function runDraft(mandate: string, d: StepDeps): Promise<StepEnd> {
  const request = d.request.id;
  const prep = await d.cli('draft-prepare', { mandate, request });
  if (prep.kind === 'refused') return { status: 'rejected', result: prep.message, outcome: 'refused' };
  if (prep.data.stale === true) {
    const why = str(prep.data.reason);
    return { status: 'done', result: `stale: ${why}`, outcome: 'stale' };
  }
  const brief = prep.data.brief;
  if (typeof brief !== 'string' || !brief.trim()) throw new RunFailed('prepare returned no brief');
  // Computed here, never taken from prepare's `staging`: the drafter's one write root.
  const root = draftsDir(d.root, d.config);
  const { sessionId } = await d.child({
    agent: OFFICE_AGENTS.drafter.agent,
    brief,
    model: validModel(prep.data.model),
    effort: validEffort(prep.data.effort),
    tools: OFFICE_AGENTS.drafter.tools,
    writeRoots: [root],
  });
  const rec = await d.cli('draft-record', { mandate, request, agentId: sessionId });
  if (rec.kind === 'refused') return { status: 'rejected', result: rec.message, outcome: 'refused' };
  const draft = (rec.data.draft ?? {}) as { issues?: unknown; waves?: unknown };
  const n = (v: unknown): string => (Number.isSafeInteger(v) ? String(v) : '?');
  return { status: 'done', result: `drafted: ${n(draft.issues)} issues in ${n(draft.waves)} waves`, outcome: 'drafted' };
}
