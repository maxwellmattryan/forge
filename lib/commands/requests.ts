// `forge requests`: the dashboard inbox. A session claims a request before handling it so two
// orchestrators draining the inbox at once cannot both act on the same one.
import { ackRequest, claimRequest, enqueue, listRequests } from '../requests.ts';
import { ForgeError } from '../util.ts';
import { req } from './args.ts';
import type { Config, ForgeRequest } from '../types.ts';

export function requestsCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): ForgeRequest | ForgeRequest[] {
  if (!sub || sub === 'list') return listRequests(root, { status: flags.all ? undefined : 'pending' });
  if (sub === 'add') return enqueue(root, config, { type: req(rest[0], 'type'), job: flags.job, text: flags.text, from: 'cli' });
  if (sub === 'claim') return claimRequest(root, req(rest[0], 'request id'), req(flags.session, '--session'), Boolean(flags.force));
  if (sub === 'ack') return ackRequest(root, req(rest[0], 'request id'), { status: flags.status ?? 'done', result: flags.result });
  throw new ForgeError('usage: forge requests [list [--all]|add TYPE|claim ID --session S|ack ID]');
}
