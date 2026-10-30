// An office run's CLI children: the seven fixed `forge` commands it may run (officeArgv), each checked word
// by word so no id, ref or reason reads as an option, the child itself (`process.execPath bin/forge …` in the
// repo, with stdout kept: runOfficeCli), how its exit and JSON are read (officeCliResult), and the env every
// child of the run gets (officeChildEnv): the daemon marker, scope `_office` and the pool's trust digest, so
// the CLI's office refusals apply. docs/architecture/foreman.md › Office runs.
import path from 'node:path';
import { MANDATE_ID_SOURCE, OFFICE_SCOPE } from '#api/constants.ts';
import { TRUST_ENV } from '#core/config/load.ts';
import { SCOPE_ENV, validJobId } from '#core/job/requests.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { sessionEnv } from '#integrations/claude/argv.ts';
import { checkLaunch } from '../../session/launch.ts';
import { spawnConfinement } from '../../session/confine.ts';
import { runChildOutput, type ChildStop } from '../../inbox/children.ts';
import { cleanReason } from '../verdict.ts';
import type { SessionContext, SessionOptions } from '../../session/contract.ts';
import type { Config } from '#core/types.ts';

const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
const REQUEST_ID = /^\d{1,20}-[A-Za-z0-9]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const REF_MAX = 200;

/** The commands an office run runs, and nothing else. */
export const OFFICE_COMMANDS = ['draft-prepare', 'draft-record', 'survey', 'board', 'start', 'resume', 'note'] as const;
export type OfficeCommand = (typeof OFFICE_COMMANDS)[number];

export interface OfficeArgs {
  mandate?: string;
  request?: string;
  agentId?: string;
  ref?: string;
  job?: string;
  reason?: string;
}

function mandateOf(a: OfficeArgs): string {
  if (typeof a.mandate !== 'string' || !MANDATE_ID.test(a.mandate)) throw new Error(`office run: invalid mandate id ${JSON.stringify(String(a.mandate).slice(0, 60))}`);
  return a.mandate;
}
function requestOf(a: OfficeArgs): string {
  if (typeof a.request !== 'string' || !REQUEST_ID.test(a.request)) throw new Error(`office run: invalid request id ${JSON.stringify(String(a.request).slice(0, 60))}`);
  return a.request;
}
function reasonOf(a: OfficeArgs): string {
  const r = cleanReason(a.reason);
  if (!r) throw new Error('office run: a reason must not be empty once cleaned');
  return `--reason=${r}`;
}

/**
 * The argv after `bin/forge` for one of the seven office commands: flags first, each value in its own
 * `--flag=value` word, then `--` and the positionals (mandate, ref, job), so none reads as an option.
 * Throws for any other command, a mandate id that fails MANDATE_ID_SOURCE, a request id that fails the
 * request-id pattern, a job id that fails validJobId, a non-UUID agent id, a ref that is empty, over 200
 * characters or holds a control character, and a reason that is empty once cleaned (cleanReason).
 */
export function officeArgv(cmd: OfficeCommand, args: OfficeArgs = {}): string[] {
  switch (cmd) {
    case 'draft-prepare':
      return ['mandate', 'draft', 'prepare', '--json', `--request=${requestOf(args)}`, '--', mandateOf(args)];
    case 'draft-record': {
      if (typeof args.agentId !== 'string' || !UUID.test(args.agentId)) throw new Error('office run: the agent id must be a UUID');
      return ['mandate', 'draft', 'record', '--json', `--request=${requestOf(args)}`, `--agent-id=${args.agentId}`, '--', mandateOf(args)];
    }
    case 'survey':
      return ['office', 'survey', '--json'];
    case 'board':
      return ['office', 'board', '--json', '--', mandateOf(args)];
    case 'start': {
      const ref = args.ref;
      if (typeof ref !== 'string' || !ref || ref.length > REF_MAX || CONTROL.test(ref)) throw new Error('office run: invalid ref');
      return ['office', 'start', '--json', reasonOf(args), '--', mandateOf(args), ref];
    }
    case 'resume':
      if (!validJobId(args.job)) throw new Error(`office run: invalid job id ${JSON.stringify(String(args.job).slice(0, 60))}`);
      return ['office', 'resume', '--json', reasonOf(args), '--', mandateOf(args), args.job];
    case 'note':
      return ['office', 'note', '--json', reasonOf(args), '--', mandateOf(args)];
    default:
      throw new Error(`office run: ${JSON.stringify(String(cmd).slice(0, 40))} is not an office command`);
  }
}

/** One CLI child as it ended: its exit code (null for a signal or a spawn error), its stdout as JSON (null when it isn't), and what went wrong around it. */
export interface OfficeCliRun {
  exit: number | null;
  json: unknown;
  /** A signal, a spawn error, a cut stdout or a timeout; null otherwise. */
  problem: string | null;
}

/** Runs one office command as a child: `process.execPath <plugin>/bin/forge …argv` in `root`, with runChildOutput's kill and timeout. */
export async function runOfficeCli(root: string, env: NodeJS.ProcessEnv, argv: string[], stop?: ChildStop): Promise<OfficeCliRun> {
  const r = await runChildOutput(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...argv], { cwd: root, env, stop, stdout: true });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout.trim());
  } catch {}
  const problem = r.error ?? (r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : null);
  return { exit: r.code, json, problem };
}

/** How the run reads a CLI child: ok with its JSON object, a refusal (exit 1-4 with `{error: {message}}`), or a crash. */
export type OfficeCliResult = { kind: 'ok'; data: Record<string, unknown> } | { kind: 'refused'; exit: number; message: string } | { kind: 'crash'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function officeCliResult(r: OfficeCliRun): OfficeCliResult {
  if (r.problem !== null) return { kind: 'crash', message: r.problem };
  if (r.exit === 0 && isObj(r.json) && !('error' in r.json)) return { kind: 'ok', data: r.json };
  const err = isObj(r.json) && isObj(r.json.error) ? r.json.error : null;
  if (r.exit !== null && r.exit >= 1 && r.exit <= 4 && err && typeof err.message === 'string') return { kind: 'refused', exit: r.exit, message: cleanReason(err.message) || 'refused' };
  return { kind: 'crash', message: `exit ${r.exit ?? 'none'} with ${r.json === null ? 'no JSON' : 'unexpected JSON'}` };
}

/**
 * The env every child of an office run gets, CLI and model alike: sessionEnv (FORGE_DAEMON=1, agent mode, git
 * pins, no API key unless daemon.auth is api-key), the confinement env, the pool's trust digest and scope
 * `_office`. Built on checkLaunch's one read of config.yml; null when a launch check refused (the pool is
 * already stopping through ctx).
 */
export function officeChildEnv(root: string, ctx: SessionContext, o: SessionOptions): { env: NodeJS.ProcessEnv; config: Config; trusted: string } | null {
  const launch = checkLaunch(root, ctx, o);
  if (!launch) return null;
  const c = launch.config;
  const confined = spawnConfinement(root, c);
  return { env: { ...sessionEnv(o.env, c.daemon.auth), ...confined.env, [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: OFFICE_SCOPE }, config: c, trusted: launch.trusted };
}
