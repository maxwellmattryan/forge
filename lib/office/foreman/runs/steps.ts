// What an office run's steps share: the deps the runner hands a draft or direct run (its CLI and model
// children, its log), how a run ends (its ack and outcome), and the two ways a step ends it early, a claim
// given back uncounted (GiveBack) or a counted failure (RunFailed). docs/architecture/foreman.md › Office runs.
import type { OfficeArgs, OfficeCliResult, OfficeCommand } from './cli.ts';
import type { ChildAgent } from '#integrations/claude/argv.ts';
import type { Config, Effort, ForgeRequest, OfficeRunOutcome } from '#core/types.ts';

/** A stop, a usage limit, a refused launch or the office cap: the claim goes back uncounted; a limit holds the runner until it resets. */
export class GiveBack extends Error {
  declare limit: { resetsAt: number | null } | null;
  constructor(message: string, limit: { resetsAt: number | null } | null = null) {
    super(message);
    this.limit = limit;
  }
}

/** A child that ended without a result, or a CLI child that crashed: the request is requeued, counted. */
export class RunFailed extends Error {}

/** One model child a step asks for. */
export interface ChildCall {
  agent: ChildAgent;
  brief: string;
  model: string | null;
  effort: Effort | null;
  tools: readonly string[];
  writeRoots: string[];
}

/** What the runner hands a run's steps. */
export interface StepDeps {
  root: string;
  /** The config the run's launch check read: argv and paths come from it. */
  config: Config;
  request: ForgeRequest;
  /** One office command as a CLI child: ok or a refusal; a crash throws RunFailed, a stop GiveBack. */
  cli(cmd: OfficeCommand, args?: OfficeArgs): Promise<Exclude<OfficeCliResult, { kind: 'crash' }>>;
  /** One model child, after the office cap is checked again: its reply text and session id; any other end throws GiveBack or RunFailed. */
  child(call: ChildCall): Promise<{ text: string; sessionId: string }>;
  log(event: string, extra?: Record<string, unknown>): void;
}

/** How a run that got to its ack ended. */
export interface StepEnd {
  status: 'done' | 'rejected';
  /** The ack's result, cut to 200 characters by the runner. */
  result: string;
  outcome: OfficeRunOutcome;
}
