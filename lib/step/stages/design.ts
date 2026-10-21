// Design: the designer writes design.md, the spec-writer folds its spec deltas in, then back to spec.
import { spawn, toStage } from '../actions.ts';
import { after, agent, ended } from '../facts.ts';
import { genericRows, missingOutputRows } from '../generic.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

/** The spec-writer started after the designer ended: it is folding the spec deltas in. */
interface DesignCtx extends Ctx {
  folding: boolean;
}

export const DESIGN: Table<DesignCtx> = {
  name: 'design',
  applies: inStage('design'),
  context: (c) => ({ ...c, folding: after(agent(c.x, 'spec-writer')?.startedAt, agent(c.x, 'designer')?.endedAt) }),
  rules: [
    { id: 'D1', when: ({ x }) => !ended(agent(x, 'designer')), then: ({ x }) => spawn(x, 'D1', 'designer') },
    missingOutputRows('designer'),
    { id: 'D2', when: ({ x, folding }) => x.designDeltas && !folding, then: ({ x }) => spawn(x, 'D2', 'spec-writer') },
    ...genericRows<DesignCtx>((c) => (c.folding ? 'spec-writer' : null)),
    { id: 'D3', when: () => true, then: ({ x }) => toStage(x, 'D3', 'spec', 'back to the spec gate with the design') },
  ],
};
