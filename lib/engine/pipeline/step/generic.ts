// The per-role rows every stage shares (NP1, NP1b, N1, N1b, N2, M1, M2) and the X1 fallback. Each is one
// row object; a stage places them with needsInputRows / missingOutputRows, which name the role. NP1 and
// NP1b park (or fail an eval) when a planner, spec writer, builder or integrator replied NEEDS-PERMISSION
// after the supervisor denied one of its prompts at daemon.permissionTimeoutMinutes.
import path from 'node:path';
import { SAFE_TOOL } from '#core/text.ts';
import { outputFor, park, safe, set, spawn } from './actions.ts';
import { PROMPT_TIMEOUT_ROLES, after, agent, ended, human, outputMissing, promptTimeoutReason, stageOf } from './facts.ts';
import type { Ctx, RoleCtx, RoleRows, Row, Rule } from './rules.ts';

export { parsePromptTimeoutReason, promptTimeoutReason } from './facts.ts';

const NEEDS_INPUT = /\bNEEDS-INPUT\b/i;
const NEEDS_PERMISSION = /\bNEEDS-PERMISSION\b/;

/**
 * The tool of the role's run that needs a timed-out prompt, or null: its agent ended replying NEEDS-PERMISSION,
 * a `permission-timed-out` event falls inside that run, and the job hasn't parked since it ended. The tool is the
 * newest such event's, checked again: events.jsonl is a file the session can reach.
 */
function timedOutAsk({ x, role }: RoleCtx): string | null {
  if (!PROMPT_TIMEOUT_ROLES.includes(role)) return null;
  const a = agent(x, role);
  if (!ended(a) || !NEEDS_PERMISSION.test(String(a.summary ?? ''))) return null;
  const e = x.events.findLast((ev) => ev.type === 'permission-timed-out' && after(ev.ts, a.startedAt) && !after(ev.ts, a.endedAt));
  if (!e) return null;
  const parked = x.events.some((ev) => ev.type === 'transition' && ['waiting', 'blocked'].includes(String(stageOf(ev.to).state)) && after(ev.ts, a.endedAt));
  if (parked) return null;
  return safe(typeof e.tool === 'string' ? e.tool : null, SAFE_TOOL, 'a tool');
}

/** NP1: an eval agent that needs a call nobody answered fails the task: no human answers an eval. */
export const NP1: Rule<RoleCtx> = {
  id: 'NP1',
  when: (c) => c.x.job.kind === 'eval' && timedOutAsk(c) !== null,
  then: ({ x }) => set(x, 'NP1', { state: 'failed', reason: 'eval: a prompt timed out and the agent needs it' }, 'an eval agent needs a tool call nobody answered'),
};

/** NP1b: the agent can't finish without a call nobody answered in time: the job parks on `escalation`, which the Foreman may decide. */
export const NP1b: Rule<RoleCtx> = {
  id: 'NP1b',
  when: (c) => timedOutAsk(c) !== null,
  then: (c) => park(c.x, 'NP1b', 'escalation', promptTimeoutReason(c.role, timedOutAsk(c) ?? 'a tool')),
};

/** The role's agent ended with a NEEDS-INPUT reply. */
const asked = ({ x, role }: RoleCtx) => {
  const a = agent(x, role);
  return ended(a) && Boolean(a.summary) && NEEDS_INPUT.test(String(a.summary));
};
/** A human answered after the agent ended. */
const answered = ({ x, role }: RoleCtx) => after(human(x, 'answer')?.ts, agent(x, role)?.endedAt);

/** N1: an eval agent that asked fails the task: no human answers an eval. */
export const N1: Rule<RoleCtx> = {
  id: 'N1',
  when: (c) => asked(c) && !answered(c) && c.x.job.kind === 'eval',
  then: ({ x }) => set(x, 'N1', { state: 'failed', reason: 'eval: NEEDS-INPUT fails the task' }, 'an eval agent asked a question'),
};

/** N1b: the job parks on `input` until a human answers. */
export const N1b: Rule<RoleCtx> = {
  id: 'N1b',
  when: (c) => asked(c) && !answered(c),
  then: ({ x, role }) => park(x, 'N1b', 'input', `${role} has questions`),
};

/** N2: answered, so the agent resumes. */
export const N2: Rule<RoleCtx> = {
  id: 'N2',
  when: asked,
  then: ({ x, role }) => spawn(x, 'N2', role, { resume: true, answered: true }),
};

/** M1: a role that ended without its output gets one retry. */
export const M1: Rule<RoleCtx> = {
  id: 'M1',
  when: ({ x, role }) => outputMissing(x, role) && !agent(x, role)?.retry,
  then: ({ x, role, retryLine }) => spawn(x, 'M1', role, { retry: true, retryLine }),
};

/** M2: the retry wrote nothing either: escalate. */
export const M2: Rule<RoleCtx> = {
  id: 'M2',
  when: ({ x, role }) => outputMissing(x, role),
  then: ({ x, role }) => {
    const file = path.basename(outputFor(x, role) ?? 'output');
    const reason = role.startsWith('reviewer:') ? `reviewer ${role.slice('reviewer:'.length)} wrote no review` : `${role} wrote no ${file}`;
    return park(x, 'M2', 'escalation', reason, `${role} ended twice without writing ${file}`);
  },
};

/** X1: no rule matched; parked visibly instead of looping. */
export const X1: Rule = {
  id: 'X1',
  when: () => true,
  then: ({ x }) => park(x, 'X1', 'escalation', `step found no rule for stage ${x.job.stage}`),
};

type RoleOf<C> = string | ((c: C) => string | null);
const roleFn = <C>(role: RoleOf<C>) => (typeof role === 'string' ? () => role : role);

/** NP1, NP1b, N1, N1b, N2 for `role` at this position. */
export const needsInputRows = <C extends Ctx>(role: RoleOf<C>): RoleRows<C> => ({ role: roleFn(role), rows: [NP1, NP1b, N1, N1b, N2] });

/** M1, M2 for `role` at this position. */
export const missingOutputRows = <C extends Ctx>(role: RoleOf<C>, retryLine?: (c: C) => string | undefined): RoleRows<C> => ({ role: roleFn(role), retryLine, rows: [M1, M2] });

/** Both, NEEDS-INPUT first. */
export const genericRows = <C extends Ctx>(role: RoleOf<C>): Row<C>[] => [needsInputRows(role), missingOutputRows(role)];
