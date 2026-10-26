// The CLI's own shapes, type-only: the dispatcher, its context and errors, status rows and the help tables.
import type { Config } from '#core/config/types.ts';
import type { ForemanHandoff, JobState, Stage, WaitingOn } from '#api/types.ts';

/** What a command runs against: mainRoot(), loadConfig() and whether `.forge/` exists. */
export interface CliContext {
  root: string;
  config: Config;
  initialized: boolean;
}

/** One command's outcome from `dispatch` in lib/cli/main.ts: `main` prints `data` unless the command `printed` itself. */
export interface Dispatched {
  data?: unknown;
  exitCode: number;
  pretty?: true;
  printed?: true;
}

/** The dispatcher, passed in so lib/cli/commands/ never imports lib/cli/main.ts. */
export type Dispatch = (argv: string[], ctx: CliContext) => Promise<Dispatched>;

/** One `forge job <sub>` handler: rest[0] is usually the job id. Its result is printed as JSON. */
export type JobHandler = (root: string, config: Config, rest: string[], flags: Record<string, any>) => unknown;

/** One command `forge job advance` ran: `result`/`error` are one line of at most 200 characters. */
export interface AdvanceRan {
  rule: string;
  command: string[];
  ok: boolean;
  result?: string;
  error?: string;
  tell?: string;
}

/** The `error` object `forge … --json` prints on stdout when a command fails: toCliError in lib/cli/commands/help.ts. */
export interface CliError {
  /** One of ERROR_CODES in lib/core/errors.ts. */
  code: string;
  message: string;
  /** The process exit code. */
  exit: number;
  /** A next command to run, or null. */
  hint: string | null;
}

/** One row of `forge status --json`: statusRows in lib/cli/commands/status.ts. */
export interface StatusRow {
  id: string;
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
  round: number;
  tasks: { done: number; total: number };
  pr: number | null;
  /** The owner's full session id. */
  session: string | null;
  /** The Foreman left the gate the job waits at for a person; null otherwise. */
  foremanHandoff: ForemanHandoff | null;
}

/** One `forge <command>` in the help tables (`HELP` beside each command module). */
export interface CommandHelp {
  /** The words after `forge`: `job step`, or the group name for a one-command group (`verify`). */
  command: string;
  /** What follows the command on its usage line: `<id> [--session S]`. */
  args: string;
  summary: string;
  /** Every flag the command reads, beyond the global ones. */
  flags?: [flag: string, meaning: string][];
  /** Every exit other than 0 and 2 the command can produce. */
  exits?: [code: 1 | 3 | 4 | 5, when: string][];
  docs?: [label: string, href: string];
  /** A row of docs/CLI.md's generated Common commands table. */
  common?: true;
}

/** A command group: `forge job …`, or a single command such as `forge verify`. */
export interface HelpGroup {
  name: string;
  summary: string;
  commands: CommandHelp[];
}
