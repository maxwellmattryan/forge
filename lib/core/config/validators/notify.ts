// notify.* validation, apart from lib/office/notify.ts so lib/core/config/validate.ts can import it without pulling in
// the delivery code (which imports lib/core/job/store.ts, which imports lib/core/config/load.ts).
import { NOTIFY_EVENTS, NOTIFY_FORMATS } from '../../job/schema.ts';
import { isMap } from '../../shape.ts';
import type { Config, NotifyWebhook } from '../../types.ts';

/** The {placeholders} notify.command may use; each becomes a quoted reference to its environment variable (lib/office/notify.ts commandSource). */
const NOTIFY_PLACEHOLDERS = ['event', 'job', 'title', 'url', 'stage', 'reason', 'dashboardUrl'] as const;

const WEBHOOK_KEYS = new Set(['url', 'events', 'format']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The URL's host only: a webhook's path and query are its secret, so nothing else is ever shown. */
export function webhookHost(url: unknown): string | null {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
}

/** Why a webhook URL is refused, or null. Messages never quote the URL. */
function webhookUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'url must be a non-empty string';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'url does not parse';
  }
  if (u.username || u.password) return 'url must not carry a username or password';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return 'url must be https: (plain http: only for 127.0.0.1, localhost or [::1])';
}

/** Why one webhook entry is unusable, or null. */
export function webhookProblem(hook: unknown): string | null {
  if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) return 'must be a map with a url';
  const h = hook as Record<string, unknown>;
  const unknown = Object.keys(h).filter((k) => !WEBHOOK_KEYS.has(k));
  if (unknown.length) return `has unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (allowed: url, events, format)`;
  const urlProblem = webhookUrlProblem(h.url);
  if (urlProblem) return urlProblem;
  if (h.events !== undefined) {
    if (!Array.isArray(h.events) || !h.events.length) return `events must be a non-empty list of ${NOTIFY_EVENTS.join(' | ')}`;
    const bad = h.events.filter((e) => !(NOTIFY_EVENTS as readonly unknown[]).includes(e));
    if (bad.length) return `events has unknown event ${JSON.stringify(bad[0])} (${NOTIFY_EVENTS.join(' | ')})`;
  }
  if (h.format !== undefined && !(NOTIFY_FORMATS as readonly unknown[]).includes(h.format)) return `format must be one of ${NOTIFY_FORMATS.join(' | ')} (got ${JSON.stringify(h.format)})`;
  return null;
}

/** The label a problem names an entry by: its index and at most its host. */
function webhookLabel(i: number, hook: unknown): string {
  const host = hook && typeof hook === 'object' ? webhookHost((hook as Record<string, unknown>).url) : null;
  return `notify.webhooks[${i}]${host ? ` (${host})` : ''}`;
}

/** Why notify.command is unusable, or null. Never quotes the command. */
export function commandProblem(command: unknown): string | null {
  if (command === null || command === undefined) return null;
  if (typeof command !== 'string' || !command.trim()) return 'notify.command must be null or a non-empty string';
  const unknown = [...command.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !(NOTIFY_PLACEHOLDERS as readonly string[]).includes(k));
  if (unknown.length) return `notify.command has unknown placeholder {${unknown[0]}} (allowed: ${NOTIFY_PLACEHOLDERS.map((k) => `{${k}}`).join(' ')})`;
  return null;
}

/** notify.*: shape problems for forge config validate and forge doctor. */
export function notifyProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const n = cfg.notify;
  if (n === undefined) return [];
  if (n === null || typeof n !== 'object' || Array.isArray(n)) return ['notify must be a map with webhooks and command'];
  const problems: string[] = [];
  if (n.webhooks !== undefined) {
    if (!Array.isArray(n.webhooks)) problems.push('notify.webhooks must be a list');
    else
      n.webhooks.forEach((hook: unknown, i: number) => {
        const p = webhookProblem(hook);
        if (p) problems.push(`${webhookLabel(i, hook)} ${p}`);
      });
  }
  const cp = commandProblem(n.command);
  if (cp) problems.push(cp);
  return problems;
}

/** The webhooks delivery uses: invalid entries are skipped (validate and doctor report them). */
export function validWebhooks(config: Pick<Config, 'notify'> | null | undefined): NotifyWebhook[] {
  const hooks = config?.notify?.webhooks;
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((h) => webhookProblem(h) === null);
}

/** The command delivery runs, or null when unset or invalid. */
export function validCommand(config: Pick<Config, 'notify'> | null | undefined): string | null {
  const cmd = config?.notify?.command;
  return typeof cmd === 'string' && commandProblem(cmd) === null ? cmd : null;
}

/** True when there is anything to deliver to. */
export function notifyConfigured(config: Pick<Config, 'notify'> | null | undefined): boolean {
  return validWebhooks(config).length > 0 || validCommand(config) !== null;
}
