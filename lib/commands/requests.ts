// `forge requests`: the dashboard inbox. A session claims a request before handling it so two
// orchestrators draining the inbox at once cannot both act on the same one. Inside a daemon session
// (FORGE_DAEMON=1) the session sees and claims only the requests routed to its scope.
import { INBOX_SCOPE, ackRequest, claimRequest, daemonScope, enqueue, listRequests, requestScope } from '../requests.ts';
import { ForgeError } from '../util.ts';
import { req } from './args.ts';
import type { Config, ForgeRequest } from '../types.ts';

const USAGE = 'usage: forge requests [list [--all]|scope|add TYPE [--job ID] [--text T] [--intake run|next]|claim ID --session S|ack ID]';

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
): ForgeRequest | ForgeRequest[] | ScopeInfo {
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
      if (flags.intake !== 'run' && flags.intake !== 'next') throw new ForgeError(`--intake must be run or next (got ${JSON.stringify(flags.intake)})`);
      args.intake = flags.intake;
    }
    // Provenance: a request one daemon session hands another says which session queued it.
    const s = scoped();
    return enqueue(root, config, { type, job: flags.job, text: flags.text, args, from: s.daemon ? `daemon:${s.scope}` : 'cli' });
  }
  if (sub === 'claim') {
    const id = req(rest[0], 'request id');
    const s = scoped();
    if (s.daemon) {
      // Looked up in the listing, so no path is built from the id before the scope check.
      const rec = listRequests(root).find((r) => r.id === id);
      const where = rec ? requestScope(root, rec) : null;
      if (where !== null && where !== s.scope) throw new ForgeError(`request ${id} belongs to scope ${where}, not this session's scope ${s.scope}`, 1);
    }
    return claimRequest(root, id, req(flags.session, '--session'), Boolean(flags.force));
  }
  if (sub === 'ack') return ackRequest(root, req(rest[0], 'request id'), { status: flags.status ?? 'done', result: flags.result });
  throw new ForgeError(USAGE);
}
