// `forge job shelve|unshelve`: a person sets a job aside and takes it off the shelf again.
import { currentActor } from '#integrations/github/actor.ts';
import { cleanShelveReason, shelveJob, unshelveJob } from '#engine/pipeline/moves/shelve.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { requireJob, str, usageError } from '../args.ts';
import { confirmHuman, unshelveOp } from '../human.ts';
import { JOB } from './help.ts';

export async function shelve(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  // A person shelves from their own terminal; the Foreman's senior pass shelves in-process through
  // recordForemanShelve (lib/office/foreman/senior.ts), never through this command.
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError('forge job shelve is run by a person in their own terminal, never by a daemon session', 1);
  const jobId = requireJob(root, rest[0]).id;
  const reason = cleanShelveReason(str(flags.reason, '--reason'));
  if (!reason || rest.length > 1) throw usageError(JOB, 'shelve');
  return shelveJob(root, config, jobId, { reason, actor: currentActor(root) });
}

export async function unshelve(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const jobId = requireJob(root, rest[0]).id;
  // A human-only operation: a person types the job id back at this terminal.
  const grant = await confirmHuman(root, unshelveOp(jobId));
  return unshelveJob(root, config, jobId, { grant });
}
