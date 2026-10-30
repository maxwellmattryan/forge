// A direct office run: `forge office survey`, then with surveyors on a board and a forge:surveyor per mandate
// with work in flight (all at once), then the plan (./plan.ts): mandates code decides, and at most one
// forge:director call for the rest. Only once every model child has ended does it run `forge office start`,
// `note` and `resume`, mandate by mandate in survey order: starts, then holds and notes, then resumes. Every
// start is re-checked by the CLI under the office lock. docs/architecture/foreman.md › Office runs.
import { resolveEffort, resolveModel, validEffort, validModel } from '#core/config/models.ts';
import { OFFICE_AGENTS } from './child.ts';
import { GiveBack, RunFailed, type StepDeps, type StepEnd } from './steps.ts';
import { directorBrief, parseDirect, parseSurvey, planDirect, surveyLines, type DirectEntry, type SurveyMandate } from './plan.ts';

/** The reasons a start carries when code decided it. */
export const LISTED_REASON = 'next listed issue';
export const FITS_REASON = "fits the mandate's free slots";
export const RESUME_REASON = 'resumable: queued with no live lease';
/** How many times one run surveys again for a listed mandate whose next issues were skipped. */
const RESURVEYS_MAX = 5;

/** Waits for every child, then rethrows: a give-back before a counted failure, so a stop never counts. */
async function settleAll<T>(calls: Promise<T>[]): Promise<T[]> {
  const out = await Promise.allSettled(calls);
  const errors = out.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  if (errors.length) throw errors.find((e) => e instanceof GiveBack) ?? errors.find((e) => e instanceof RunFailed) ?? errors[0];
  return out.map((r) => (r as PromiseFulfilledResult<T>).value);
}

async function survey(d: StepDeps) {
  const r = await d.cli('survey');
  if (r.kind === 'refused') return r;
  try {
    return { kind: 'ok' as const, survey: parseSurvey(r.data) };
  } catch (e) {
    throw new RunFailed(`the survey can't be read: ${(e as Error).message}`);
  }
}

/** The surveyors' SURVEY: lines by mandate: one board and one child per mandate with work in flight; a refused board skips its mandate. */
async function surveyors(d: StepDeps, mandates: SurveyMandate[]): Promise<Map<string, string[]>> {
  const boards: { id: string; brief: string; model: string | null; effort: ReturnType<typeof validEffort> }[] = [];
  for (const m of mandates.filter((x) => x.inFlight > 0)) {
    const b = await d.cli('board', { mandate: m.id });
    if (b.kind === 'refused') {
      d.log('error', { message: `board ${m.id} refused: ${b.message}` });
      continue;
    }
    if (typeof b.data.brief !== 'string' || !b.data.brief.trim()) throw new RunFailed(`board ${m.id} returned no brief`);
    boards.push({ id: m.id, brief: b.data.brief, model: validModel(b.data.model), effort: validEffort(b.data.effort) });
  }
  const replies = await settleAll(boards.map((b) => d.child({ agent: OFFICE_AGENTS.surveyor.agent, brief: b.brief, model: b.model, effort: b.effort, tools: OFFICE_AGENTS.surveyor.tools, writeRoots: [] })));
  return new Map(boards.map((b, i) => [b.id, surveyLines(replies[i].text)]));
}

export async function runDirect(d: StepDeps): Promise<StepEnd> {
  const first = await survey(d);
  if (first.kind === 'refused') return { status: 'rejected', result: first.message, outcome: 'refused' };
  const { mandates, surveyorsEnabled } = first.survey;
  if (!mandates.some((m) => m.candidates.length || m.resumable.length)) return { status: 'done', result: 'nothing to direct', outcome: 'directed' };

  const lines = surveyorsEnabled ? await surveyors(d, mandates) : new Map<string, string[]>();
  const plan = planDirect(mandates, lines);
  // At most one director call, and only for a real choice.
  let verdict: { start: DirectEntry[]; hold: DirectEntry[] } | null = null;
  if (plan.asked.length) {
    const c = d.config;
    const reply = await d.child({
      agent: OFFICE_AGENTS.director.agent,
      brief: directorBrief(plan.asked, lines),
      model: resolveModel(c, null, 'director'),
      effort: resolveEffort(c, null, 'director').level,
      tools: OFFICE_AGENTS.director.tools,
      writeRoots: [],
    });
    verdict = parseDirect(reply.text, plan.asked);
    if (!verdict) d.log('error', { message: 'director reply unparseable: every asked mandate starts nothing' });
  }

  // Every model child has ended: only now does the run start, note or resume anything.
  let started = 0;
  let resumed = 0;
  let held = 0;
  const asked = new Set(plan.asked.map((m) => m.id));
  const plain = new Map(plan.plain.map((p) => [p.id, p.refs]));
  for (const m of mandates) {
    const tried = new Set<string>();
    let mine = 0;
    /** Walks `list` until `free` starts succeeded; false once a start refused, which stops starting for this mandate. */
    const walk = async (list: { ref: string; reason: string }[]): Promise<{ refused: boolean; skipped: boolean }> => {
      let skipped = false;
      for (const { ref, reason } of list) {
        if (mine >= m.free) break;
        if (tried.has(ref)) continue;
        tried.add(ref);
        const r = await d.cli('start', { mandate: m.id, ref, reason });
        if (r.kind === 'refused') {
          d.log('error', { message: `start ${m.id} ${ref} refused (exit ${r.exit}): ${r.message}` });
          return { refused: true, skipped };
        }
        if (r.data.skipped === true) skipped = true;
        else mine++;
      }
      return { refused: false, skipped };
    };
    const refs = plain.get(m.id);
    if (refs) {
      const reason = m.order === 'listed' ? LISTED_REASON : FITS_REASON;
      let w = await walk(refs.map((ref) => ({ ref, reason })));
      // A skipped listed issue moves the window: survey again for the issues after it.
      for (let n = 0; m.order === 'listed' && !w.refused && w.skipped && mine < m.free && n < RESURVEYS_MAX; n++) {
        const again = await survey(d);
        const fresh = again.kind === 'ok' ? again.survey.mandates.find((x) => x.id === m.id) : undefined;
        const next = (fresh?.candidates ?? []).map((c) => c.ref).filter((ref) => !tried.has(ref));
        if (!next.length) break;
        w = await walk(next.map((ref) => ({ ref, reason })));
      }
    } else if (asked.has(m.id)) {
      if (verdict) {
        await walk(verdict.start.filter((e) => e.mandate === m.id));
        const holds = verdict.hold.filter((e) => e.mandate === m.id);
        for (const h of holds) await note(d, m.id, `held ${h.ref}: ${h.reason}`);
        held += holds.length;
        if (!holds.length && !verdict.start.some((e) => e.mandate === m.id)) {
          await note(d, m.id, `the director started none of ${m.candidates.length} candidates`);
          held += m.candidates.length;
        }
      } else {
        await note(d, m.id, `director reply unparseable: started none of ${m.candidates.length} candidates`);
        held += m.candidates.length;
      }
    }
    started += mine;
    for (const job of m.resumable) {
      const r = await d.cli('resume', { mandate: m.id, job, reason: RESUME_REASON });
      if (r.kind === 'refused') d.log('error', { message: `resume ${m.id} ${job} refused: ${r.message}` });
      else resumed++;
    }
  }
  const holdText = held > 0 || (plan.asked.length > 0 && !verdict) ? `, held ${held}` : '';
  return { status: 'done', result: `started ${started}, resumed ${resumed}${holdText}`, outcome: 'directed' };
}

async function note(d: StepDeps, mandate: string, reason: string): Promise<void> {
  const r = await d.cli('note', { mandate, reason });
  if (r.kind === 'refused') d.log('error', { message: `note ${mandate} refused: ${r.message}` });
}
