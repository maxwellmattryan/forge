// Spec: the spec-writer writes spec.md, step records the panel, then the spec gate and the issue link.
import { issueLinkStatus } from '../../issue-link.ts';
import { COMPLEXITIES } from '../../schema.ts';
import type { JobAgent, StepInput } from '../../types.ts';
import { SAFE_REF } from '../../util.ts';
import { park, set, spawn, toStage } from '../actions.ts';
import { after, agent, ended, human, lastEvent } from '../facts.ts';
import { genericRows } from '../generic.ts';
import { selectPanel } from '../panel.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

interface SpecCtx extends Ctx {
  sw: JobAgent | undefined;
  /** When the spec was last written: the spec-writer's or the retro's end, whichever is later. */
  authored: string | null;
  /** The job has no issue yet. */
  missing: boolean;
}

function context(c: Ctx): SpecCtx {
  const ends = ['spec-writer', 'retro'].map((r) => agent(c.x, r)).filter(ended).map((a) => String(a.endedAt));
  return { ...c, sw: agent(c.x, 'spec-writer'), authored: ends.sort().at(-1) ?? null, missing: issueLinkStatus(c.x.job, c.x.config) === 'missing' };
}

/** SP3's fields: the panel, and the size, complexity and services the spec header names. */
function panelFields(x: StepInput): string[] {
  const fields = [`reviewers=${JSON.stringify(selectPanel(x))}`];
  if (x.spec.size && /^[SML]$/.test(x.spec.size)) fields.push(`size=${x.spec.size}`);
  const complexity = (COMPLEXITIES as readonly (string | null)[]).includes(x.spec.complexity) ? x.spec.complexity : null;
  // A revised spec without the line must not keep a stale level-picking value.
  if (complexity) fields.push(`complexity=${complexity}`);
  else if (x.job.complexity != null) fields.push('complexity=null');
  const services = x.spec.services.filter((s) => SAFE_REF.test(s) && x.config.components.some((cs) => cs.name === s));
  if (services.length) fields.push(`services=${JSON.stringify(services)}`);
  return fields;
}

const gated = ({ x }: Ctx) => {
  const c = x.config;
  const size = x.job.size ?? x.spec.size;
  return c.pipeline.specApproval === 'always' || (c.pipeline.specApproval === 'large' && size === 'L') || x.job.kind === 'retro';
};

export const SPEC: Table<SpecCtx> = {
  name: 'spec',
  applies: inStage('spec'),
  context,
  rules: [
    { id: 'SP1', when: (c) => c.x.job.kind !== 'retro' && !ended(c.sw), then: ({ x }) => spawn(x, 'SP1', 'spec-writer') },
    {
      id: 'SP2',
      when: ({ x, sw }) => after(human(x, 'revise-spec')?.ts, sw?.startedAt) || Boolean(sw && after(human(x, 'reject-repos')?.ts, sw.startedAt)),
      then: ({ x }) => spawn(x, 'SP2', 'spec-writer'),
    },
    ...genericRows<SpecCtx>((c) => (c.sw ? 'spec-writer' : null)),
    {
      id: 'SP3',
      when: ({ x, authored }) => !after(lastEvent(x, (e) => e.type === 'fields' && Boolean(e.fields && typeof e.fields === 'object' && 'reviewers' in (e.fields as object)))?.ts, authored),
      then: ({ x }) => set(x, 'SP3', { fields: panelFields(x) }, 'record the review panel the spec implies'),
    },
    { id: 'SP4', when: ({ x }) => x.config.pipeline.design !== 'none' && x.spec.needsDesign && !ended(agent(x, 'designer')), then: ({ x }) => toStage(x, 'SP4', 'design', 'the spec needs design') },
    {
      id: 'SP5',
      when: (c) => gated(c) && c.x.job.kind !== 'eval' && !after(human(c.x, 'approve-spec')?.ts, c.authored),
      // `, ` not ` · `: shellLine refuses characters outside its safe class.
      then: ({ x, missing }) => set(x, 'SP5', { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: missing ? 'spec ready, issue unlinked' : 'spec ready' }, 'a human approves the spec'),
    },
    // The builder never starts on an unlinked job: a spec approved without a link, or one no gate stopped.
    { id: 'SP7', when: (c) => c.missing, then: ({ x }) => park(x, 'SP7', 'issue-link', 'link an issue before build') },
    { id: 'SP6', when: () => true, then: ({ x }) => toStage(x, 'SP6', 'build', 'the spec is ready to build') },
  ],
};
