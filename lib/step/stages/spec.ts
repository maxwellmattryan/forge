// Spec: the spec-writer writes spec.md, step records the panel, then the spec gate and the issue link.
import { issueLinkStatus } from '../../issue-link.ts';
import { COMPLEXITIES } from '../../schema.ts';
import type { StepAction, StepInput } from '../../types.ts';
import { SAFE_REF } from '../../util.ts';
import { park, set, spawn, toStage } from '../actions.ts';
import { after, agent, ended, human, lastEvent } from '../facts.ts';
import { generic } from '../generic.ts';
import { selectPanel } from '../panel.ts';

/** When the spec was last written: the spec-writer's or the retro's end, whichever is later. */
function specAuthorEnd(x: StepInput): string | null {
  const ends = ['spec-writer', 'retro'].map((r) => agent(x, r)).filter(ended).map((a) => String(a.endedAt));
  return ends.sort().at(-1) ?? null;
}

export function spec(x: StepInput): StepAction {
  const j = x.job;
  const c = x.config;
  const sw = agent(x, 'spec-writer');
  if (j.kind !== 'retro' && !ended(sw)) return spawn(x, 'SP1', 'spec-writer');
  if (after(human(x, 'revise-spec')?.ts, sw?.startedAt) || (sw && after(human(x, 'reject-repos')?.ts, sw.startedAt))) return spawn(x, 'SP2', 'spec-writer');
  if (sw) {
    const g = generic(x, 'spec-writer');
    if (g) return g;
  }
  const authored = specAuthorEnd(x);
  const panelEv = lastEvent(x, (e) => e.type === 'fields' && Boolean(e.fields && typeof e.fields === 'object' && 'reviewers' in (e.fields as object)));
  if (!after(panelEv?.ts, authored)) {
    const fields = [`reviewers=${JSON.stringify(selectPanel(x))}`];
    if (x.spec.size && /^[SML]$/.test(x.spec.size)) fields.push(`size=${x.spec.size}`);
    const complexity = (COMPLEXITIES as readonly (string | null)[]).includes(x.spec.complexity) ? x.spec.complexity : null;
    // A revised spec without the line must not keep a stale level-picking value.
    if (complexity) fields.push(`complexity=${complexity}`);
    else if (j.complexity != null) fields.push('complexity=null');
    const services = x.spec.services.filter((s) => SAFE_REF.test(s) && c.components.some((cs) => cs.name === s));
    if (services.length) fields.push(`services=${JSON.stringify(services)}`);
    return set(x, 'SP3', { fields }, 'record the review panel the spec implies');
  }
  if (c.pipeline.design !== 'none' && x.spec.needsDesign && !ended(agent(x, 'designer'))) return toStage(x, 'SP4', 'design', 'the spec needs design');
  const size = j.size ?? x.spec.size;
  const gated = c.pipeline.specApproval === 'always' || (c.pipeline.specApproval === 'large' && size === 'L') || j.kind === 'retro';
  const missing = issueLinkStatus(j, c) === 'missing';
  if (gated && j.kind !== 'eval' && !after(human(x, 'approve-spec')?.ts, authored)) {
    // `, ` not ` · `: shellLine refuses characters outside its safe class.
    const reason = missing ? 'spec ready, issue unlinked' : 'spec ready';
    return set(x, 'SP5', { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason }, 'a human approves the spec');
  }
  // The builder never starts on an unlinked job: a spec approved without a link, or one no gate stopped.
  if (missing) return park(x, 'SP7', 'issue-link', 'link an issue before build');
  return toStage(x, 'SP6', 'build', 'the spec is ready to build');
}
