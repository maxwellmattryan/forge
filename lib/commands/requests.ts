// `forge requests`: the dashboard inbox. A session claims a request before handling it so two
// orchestrators draining the inbox at once cannot both act on the same one. Inside a daemon session
// (FORGE_DAEMON=1) the session sees and claims only the requests routed to its scope.
import path from 'node:path';
import { inboxSessionIds } from '../daemon-owner.ts';
import { releaseJob } from '../jobs.ts';
import { exists, paths } from '../paths.ts';
import { INBOX_SCOPE, ackRequest, claimRequest, daemonScope, enqueue, listRequests, requestScope, validJobId } from '../requests.ts';
import { ForgeError } from '../util.ts';
import { req } from './args.ts';
import type { Config, ForgeRequest } from '../types.ts';

const USAGE = 'usage: forge requests [list [--all]|scope|add TYPE [--job ID] [--text T] [--intake run|next|new] [--session S]|claim ID --session S|ack ID]';

/** What `forge requests scope` prints: which session this is, so the orchestrator knows its role. */
export interface ScopeInfo {
  daemon: boolean;
  scope: 'inbox' | 'job' | null;
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
    const all = listRequests(root, { status: flags.all ? undefined : 'pending' });
    return s.daemon ? all.filter((r) => requestScope(root, r) === s.scope) : all;
  }
  if (sub === 'scope') {
    const s = scoped();
    if (!s.daemon) return { daemon: false, scope: null, job: null };
    return s.scope === INBOX_SCOPE ? { daemon: true, scope: 'inbox', job: null } : { daemon: true, scope: 'job', job: s.scope };
  }
  if (sub === 'add') {
    const type = req(rest[0], 'type');
    const args: Record<string, string> = {};
    if (flags.intake !== undefined) {
      if (type !== 'resume') throw new ForgeError('--intake is only for resume requests');
      if (!['run', 'next', 'new'].includes(flags.intake)) throw new ForgeError(`--intake must be run, next or new (got ${JSON.stringify(flags.intake)})`);
      args.intake = flags.intake;
    }
    // A guardrail against accidental cross-job requests, not a security boundary: provenance comes
    // from the caller's environment and isn't authenticated (docs/ARCHITECTURE.md "Untrusted input").
    // The only hand-off the skill needs is resume, so a session following the skill never queues a
    // human decision for another job's session.
    const s = scoped();
    if (s.daemon && type !== 'resume') throw new ForgeError(`a daemon session queues only resume hand-offs (got ${JSON.stringify(type)}); a session following the skill hands off only resume`);
    const rec = enqueue(root, config, { type, job: flags.job, text: flags.text, args, from: s.daemon ? `daemon:${s.scope}` : 'cli' });
    if (type !== 'resume') return rec;
    // A hand-off lets go of the claim, so the job's session can take it without --force: when the
    // caller names itself as the owner, or the inbox hands off a job one of its sessions claimed.
    const job = rec.job;
    if (!validJobId(job) || !exists(path.join(paths(root).jobs, job, 'job.json'))) return { ...rec, released: false };
    const session = typeof flags.session === 'string' && flags.session ? flags.session : null;
    const inbox = s.daemon && s.scope === INBOX_SCOPE ? inboxSessionIds(root) : [];
    const released = releaseJob(root, job, (o) => Boolean(o && ((session !== null && o.session === session) || inbox.includes(o.session))));
    return { ...rec, released };
  }
  if (sub === 'claim' || sub === 'ack') {
    const id = req(rest[0], 'request id');
    const s = scoped();
    // A daemon session may act only on a request it can see: one that exists and is routed to its
    // scope. Looked up in the listing, so no path is built from the id before the check.
    if (s.daemon) {
      const rec = listRequests(root).find((r) => r.id === id);
      if (!rec) throw new ForgeError(`no request ${JSON.stringify(String(id).slice(0, 80))} in this daemon session's scope ${s.scope}`, 1);
      const where = requestScope(root, rec);
      if (where !== s.scope) throw new ForgeError(`request ${id} belongs to scope ${where}, not this session's scope ${s.scope}`, 1);
    }
    if (sub === 'claim') return claimRequest(root, id, req(flags.session, '--session'), Boolean(flags.force));
    return ackRequest(root, id, { status: flags.status ?? 'done', result: flags.result });
  }
  throw new ForgeError(USAGE);
}
