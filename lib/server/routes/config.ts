// Settings routes: the config view with webhooks masked, one config change, and the repo budget
// acknowledgement.
import type http from 'node:http';
import { loadConfig, validateConfig } from '#core/config/load.ts';
import { ConfigSetError, FIELDS } from '#core/config/fields.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { setConfigValue } from '#core/config/set.ts';
import { RepoBudgetAckError, ackRepoBudget, validPeriod } from '#engine/metrics/repo-budget.ts';
import { getPath } from '#core/shape.ts';
import type { ConfigResponse, PostBudgetAckResponse, PostConfigResponse } from '#core/types.ts';
import { json, jsonStatus, readBody } from '../http.ts';
import type { ServerCtx } from '../types.ts';

const DAEMON_LOCK = 'stop the daemon first: any change to .forge/config.yml stops it, and only a human may start it again';
const CONFIG_STATUS: Record<ConfigSetError['reason'], number> = { unknown: 400, invalid: 400, locked: 403, uninitialized: 409, 'unsupported-yaml': 409 };

/** GET /api/config: the settings fields and their values. */
export function getConfig(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  return json(res, configResponse(root, Boolean(ctx.pool?.state().wanted)));
}

/** POST /api/config: one config change. */
export async function postConfig(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return jsonStatus(res, 400, { error: 'body is not JSON' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.key !== 'string' || !Object.prototype.hasOwnProperty.call(body, 'value'))
    return jsonStatus(res, 400, { error: 'body must be {"key": string, "value": …}' });
  // A change would trip the daemon's trust check mid-turn, and only a human may restart it.
  if (ctx.pool?.state().wanted) return jsonStatus(res, 409, { error: DAEMON_LOCK });
  try {
    const r = setConfigValue(root, body.key, body.value, dashboardActor);
    if (r.changed) ctx.backlogCache = null;
    return json(res, r satisfies PostConfigResponse);
  } catch (e) {
    if (e instanceof ConfigSetError) return jsonStatus(res, CONFIG_STATUS[e.reason], { error: e.message });
    throw e;
  }
}

// Not blocked by the daemon lock: an ack is an audit line, never a config.yml change.
export async function postBudgetAck(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return jsonStatus(res, 400, { error: 'body is not JSON' });
  }
  const period = body && typeof body === 'object' && !Array.isArray(body) ? body.period : undefined;
  if (!validPeriod(period)) return jsonStatus(res, 400, { error: 'period must be the current UTC month (YYYY-MM) or day (YYYY-MM-DD)' });
  try {
    const r = ackRepoBudget(root, loadConfig(root).config, period, null, dashboardActor());
    ctx.budgetCache = { at: Date.now(), data: r.status };
    ctx.pool?.poke();
    return json(res, r.status satisfies PostBudgetAckResponse);
  } catch (e) {
    if (e instanceof RepoBudgetAckError) return jsonStatus(res, e.reason === 'within' ? 409 : 400, { error: e.message });
    throw e;
  }
}

/** A webhook's path and query are its secret (a Slack URL is a bearer token), so the dashboard gets scheme and host. */
function maskWebhooks(hooks: unknown): unknown {
  if (!Array.isArray(hooks)) return hooks;
  return hooks.map((h) => {
    // A malformed entry may be a bare URL string, so it is masked whole.
    if (!h || typeof h !== 'object' || Array.isArray(h)) return '<invalid>';
    let url = '<invalid>';
    try {
      const u = new URL(String((h as { url?: unknown }).url));
      url = `${u.protocol}//${u.host}/…`;
    } catch {}
    return { ...h, url };
  });
}

function configResponse(root: string, daemonWanted: boolean): ConfigResponse {
  const { config, initialized } = loadConfig(root);
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, getPath(config, f.key) ?? null]));
  values['notify.webhooks'] = maskWebhooks(values['notify.webhooks']);
  // A command can embed a webhook URL or an auth header; the field is locked, so the dashboard never needs its text.
  if (values['notify.command'] !== null) values['notify.command'] = '<set>';
  const lockedBy = !initialized ? 'uninitialized' : daemonWanted ? 'daemon' : null;
  return { initialized, path: '.forge/config.yml', fields: FIELDS, values, problems: initialized ? validateConfig(config, root) : [], writable: lockedBy === null, lockedBy };
}
