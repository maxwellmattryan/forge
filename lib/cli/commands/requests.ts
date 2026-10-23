// `forge requests`: the dashboard inbox. A session claims a request before handling it so two
// orchestrators draining the inbox at once cannot both act on the same one. Inside a daemon session
// (FORGE_DAEMON=1) the session sees and claims only the requests routed to its scope.
import path from 'node:path';
import { inboxSessionIds } from '#office/driver.ts';
import { releaseJob, requeueOrphanedRequests } from '#core/job/store.ts';
import { exists, paths } from '#core/paths.ts';
import { dashRunning } from '#office/reconcile.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, ackRequest, claimRequest, daemonScope, enqueue, listRequests, requestScope, validJobId } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { req, str, usageError } from './args.ts';
import type { Config, ForgeRequest } from '#core/types.ts';
import type { HelpGroup } from '../types.ts';

const REQUESTS: HelpGroup = {
  name: 'requests',
  summary: "the dashboard's inbox of requests for an orchestrator session",
  commands: [
    {
      command: 'requests list',
      args: '[--all]',
      summary: "pending requests (`forge requests` alone does the same); in a daemon session, only its scope's. First returns to pending any in-progress request whose session is gone (its job lease expired, or its claim is 30 minutes old); one orphaned twice is rejected",
      flags: [['--all', 'include handled requests']],
      exits: [[1, "a daemon session's scope is invalid"]],
    },
    { command: 'requests scope', args: '', summary: 'which session this is: not a daemon, the inbox, the office, or one job', exits: [[1, "a daemon session's scope is invalid"]] },
    {
      command: 'requests add',
      args: '<type> [--job ID] [--text T] [--intake run|next|new] [--session S]',
      summary: 'queue a request; a resume hand-off also releases the claim of the session handing off',
      flags: [
        ['--job ID', 'the job it is about'],
        ['--text T', 'its text'],
        ['--intake run|next|new', 'with resume: how the job starts'],
        ['--session S', 'with resume: the session handing the job off'],
      ],
      exits: [[1, 'a gate request (only the CLI writes those), a daemon session queued anything but resume, or its scope is invalid']],
    },
    {
      command: 'requests claim',
      args: '<id> --session S [--force]',
      summary: 'claim a request before handling it',
      flags: [
        ['--session S', 'the claiming session (required)'],
        ['--force', 'take it from a live session'],
      ],
      exits: [
        [1, "no such request, or one outside this daemon session's scope"],
        [3, 'another live session is handling it'],
      ],
    },
    {
      command: 'requests ack',
      args: '<id> [--status done|rejected] [--result R]',
      summary: 'mark a request handled',
      flags: [
        ['--status S', 'done (default) or rejected'],
        ['--result R', 'one line on what happened'],
      ],
      exits: [[1, "no such request, or one outside this daemon session's scope"]],
    },
  ],
};

export const HELP: HelpGroup[] = [REQUESTS];

/** What `forge requests scope` prints: which session this is, so the orchestrator knows its role. */
export interface ScopeInfo {
  daemon: boolean;
  scope: 'inbox' | 'office' | 'job' | null;
  job: string | null;
}

export function requestsCmd(
  root: string,
  config: Config,
  sub: string | undefined,
  rest: string[],
  flags: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): ForgeRequest | (ForgeRequest & { released: boolean }) | ForgeRequest[] | ScopeInfo {
  const scoped = () => {
    const s = daemonScope(env);
    if ('problem' in s) throw new ForgeError(s.problem);
    return s;
  };
  if (!sub || sub === 'list') {
    const s = scoped();
    // First, so a drain without `forge dash` sees the requests a dead session left claimed. While a
    // dash runs, its reconciler applies the claim-age rule: only it knows which sessions are mid-turn.
    requeueOrphanedRequests(root, { byAge: !dashRunning(root) });
    const all = listRequests(root, { status: flags.all ? undefined : 'pending' });
    return s.daemon ? all.filter((r) => requestScope(root, r) === s.scope) : all;
  }
  if (sub === 'scope') {
    const s = scoped();
    if (!s.daemon) return { daemon: false, scope: null, job: null };
    if (s.scope === INBOX_SCOPE) return { daemon: true, scope: 'inbox', job: null };
    if (s.scope === OFFICE_SCOPE) return { daemon: true, scope: 'office', job: null };
    return { daemon: true, scope: 'job', job: s.scope };
  }
  if (sub === 'add') {
    const type = req(rest[0], 'type');
    // Gate requests carry the reserved check's result, so only the CLI's park and sync paths write them.
    if (type === 'gate') throw new ForgeError('gate requests are written only by forge job set and forge pr sync, never queued by hand', 1);
    // Read before enqueue, so a bare --job or --session queues nothing.
    const jobFlag = str(flags.job, '--job');
    const session = str(flags.session, '--session') ?? null;
    const args: Record<string, string> = {};
    if (flags.intake !== undefined) {
      if (type !== 'resume') throw new ForgeError('--intake is only for resume requests', 'usage');
      if (!['run', 'next', 'new'].includes(flags.intake)) throw new ForgeError(`--intake must be run, next or new (got ${JSON.stringify(flags.intake)})`, 'usage');
      args.intake = flags.intake;
    }
    // A guardrail against accidental cross-job requests, not a security boundary: provenance comes
    // from the caller's environment and isn't authenticated (docs/architecture/untrusted-input.md).
    // The only hand-off the skill needs is resume, so a session following the skill never queues a
    // human decision for another job's session.
    const s = scoped();
    if (s.daemon && type !== 'resume') throw new ForgeError(`a daemon session queues only resume hand-offs (got ${JSON.stringify(type)}); a session following the skill hands off only resume`);
    const rec = enqueue(root, config, { type, job: jobFlag, text: flags.text, args, from: s.daemon ? `daemon:${s.scope}` : 'cli' });
    if (type !== 'resume') return rec;
    // A hand-off lets go of the claim, so the job's session can take it without --force: when the
    // caller names itself as the owner, or the inbox hands off a job one of its sessions claimed.
    const job = rec.job;
    if (!validJobId(job) || !exists(path.join(paths(root).jobs, job, 'job.json'))) return { ...rec, released: false };
    const inbox = s.daemon && s.scope === INBOX_SCOPE ? inboxSessionIds(root) : [];
    const released = releaseJob(root, job, (l) => Boolean(l.driver && ((session !== null && l.driver === session) || inbox.includes(l.driver))));
    return { ...rec, released };
  }
  if (sub === 'claim' || sub === 'ack') {
    const id = req(rest[0], 'request id');
    const s = scoped();
    // A daemon session may act only on a request it can see: one that exists and is routed to its
    // scope. Looked up in the listing, so no path is built from the id before the check.
    if (s.daemon) {
      const rec = listRequests(root).find((r) => r.id === id);
      if (!rec) throw new ForgeError(`no request ${JSON.stringify(String(id).slice(0, 80))} in this daemon session's scope ${s.scope}`, 'not_found');
      const where = requestScope(root, rec);
      if (where !== s.scope) throw new ForgeError(`request ${id} belongs to scope ${where}, not this session's scope ${s.scope}`, 1);
    }
    if (sub === 'claim') return claimRequest(root, id, req(str(flags.session, '--session'), '--session'), Boolean(flags.force));
    return ackRequest(root, id, { status: flags.status ?? 'done', result: flags.result });
  }
  throw usageError(REQUESTS);
}
