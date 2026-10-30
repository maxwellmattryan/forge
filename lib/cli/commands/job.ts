// `forge job …`: every write to a job's state goes through here.
import { OFFICE_REFUSAL } from '#office/session/permissions/owner.ts';
import { OFFICE_JOB_COMMANDS } from '#office/foreman/policy.ts';
import { inOffice } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import type { JobHandler } from '../types.ts';
import { usageError } from './args.ts';
import { JOB } from './job/help.ts';
import { fromRef, link, newCmd } from './job/create.ts';
import { acs, audit, findings, get, links, listCmd, panel, paths, progressCmd, scope, show } from './job/read.ts';
import { budget, effort, note, refreshRequestCmd, set } from './job/state.ts';
import { claim, release, stepCmd } from './job/lease.ts';
import { assistCmd, human } from './job/decide.ts';
import { interim, repo } from './job/repos.ts';
import { agent } from './job/agent.ts';
import { decision, gate, round, score, verdicts } from './job/review.ts';
import { archive, deleteCmd, pruneCmd } from './job/retention.ts';
import { shelve, unshelve } from './job/shelf.ts';

/** Each `forge job <sub>` word to its handler, in the help table's order; `advance` is routed by lib/cli/main.ts. Exported for its test. */
export const JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  new: newCmd,
  'from-ref': fromRef,
  link,
  list: listCmd,
  show,
  get,
  set,
  effort,
  claim,
  release,
  'refresh-request': refreshRequestCmd,
  repo,
  interim,
  note,
  human,
  assist: assistCmd,
  agent,
  round,
  budget,
  shelve,
  unshelve,
  audit,
  archive,
  delete: deleteCmd,
  prune: pruneCmd,
  verdicts,
  gate,
  decision,
  score,
  progress: progressCmd,
  paths,
  links,
  scope,
  panel,
  acs,
  findings,
  step: stepCmd,
};

/**
 * The office reads and notes, nothing else: an allowlist, so a new subcommand starts out refused there.
 * lib/cli/main.ts asks it before routing `forge job advance` too.
 */
export function refuseForemanJobCommand(sub: string | undefined): void {
  if (OFFICE_JOB_COMMANDS.includes(String(sub))) return;
  if (inOffice()) throw new ForgeError(`${OFFICE_REFUSAL}; forge job ${String(sub).slice(0, 40)} is not available in the office session`, 1);
}

/** The result is printed as JSON. */
export async function jobCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  refuseForemanJobCommand(sub);
  // Own keys only, so `constructor`, `__proto__` and their kind get the usage error, as the old switch's default did.
  const handler = sub !== undefined && Object.hasOwn(JOB_HANDLERS, sub) ? JOB_HANDLERS[sub] : undefined;
  if (!handler) throw usageError(JOB);
  return handler(root, config, rest, flags);
}
