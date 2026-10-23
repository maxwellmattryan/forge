// Notifications: a small, fixed-shape message to the team's webhooks and command when a job needs a
// human, a PR opens or merges, a job fails, the daemon stops, a budget is exceeded or a secret is
// found. This is the only module that does network I/O or runs notify.command. Triggers call
// queueNotify, which hands delivery to a detached `forge notify send` child, so a slow endpoint
// never stalls the command that changed state. Delivery is best effort: nothing here throws into
// a caller or changes job state.
//
// What leaves the machine is fixed: the reason is an English string chosen by code, never job text;
// the title is the only free text and is control-stripped and capped. A webhook's path and query
// are its secret, so only its host is ever recorded or shown.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { openAppend } from '#core/job/session-files.ts';
import { jobDir, loadJob, logEvent, onTransition } from '#core/job/store.ts';
import { commandProblem, notifyConfigured, validCommand, validWebhooks, webhookHost, webhookProblem } from '#core/config/validators/notify.ts';
import { PLUGIN_ROOT, exists, paths } from '#core/paths.ts';
import { posixShell } from '#core/os/platform.ts';
import { EVENT_SCHEMA_VERSION, NOTIFY_EVENTS, NOTIFY_GATES } from '#core/job/schema.ts';
import type { Config, DoctorCheck, Job, NotifyEvent, NotifyWebhook, TransitionSide } from '#core/types.ts';
import { readJson } from '#core/os/fs.ts';

export { notifyProblems, validWebhooks, validCommand, notifyConfigured, webhookHost } from '#core/config/validators/notify.ts';

/** Every reason code a notification can carry, with the fixed text the payload sends. */
export const REASONS = {
  'spec-approval': 'Spec is waiting for approval',
  'split-approval': 'A proposed split is waiting for approval',
  'issue-link': 'The job needs an issue linked before it can continue',
  input: 'An agent has questions only a human can answer',
  escalation: 'The approver escalated the job to a human',
  infra: 'Infrastructure steps are waiting for a human',
  conflicts: 'The branch has merge conflicts waiting for a human',
  'rounds-exhausted': 'Review rounds are exhausted',
  budget: 'The job stopped at its budget',
  human: 'A Forge check stopped the job until a human clears it',
  failed: 'The job failed',
  'pr-opened': 'A pull request was opened',
  'pr-merged': 'The pull request was merged',
  'secret-found': "A likely secret was found in the job's changes",
  trust: "The daemon stopped because Forge's trusted config changed",
  'failed-turns': 'The daemon stopped after repeated failed turns',
  'failed-starts': 'The daemon stopped after repeated failed starts',
  test: 'Test notification from forge notify test',
} as const;
export type ReasonCode = keyof typeof REASONS;

/** The Slack header label per event. */
export const LABELS: Record<NotifyEvent, string> = {
  gate: 'Needs you',
  'pr-opened': 'PR opened',
  'pr-merged': 'PR merged',
  'job-failed': 'Job failed',
  'daemon-stopped': 'Daemon stopped',
  'budget-exceeded': 'Budget exceeded',
  'secret-found': 'Secret found',
};

export const isNotifyEvent = (e: unknown): e is NotifyEvent => (NOTIFY_EVENTS as readonly unknown[]).includes(e);
export const isReasonCode = (r: unknown): r is ReasonCode => typeof r === 'string' && Object.hasOwn(REASONS, r);

/** The JSON body (format: json): exactly these keys. */
export interface NotifyPayload {
  event: NotifyEvent;
  job: string | null;
  title: string | null;
  stage: string | null;
  reason: string;
  url: string | null;
  dashboardUrl: string;
  at: string;
}

/** What one target's delivery came to. */
export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: 'timeout' | 'network' | 'http' | 'redirect' | 'invalid' | 'exit' | 'spawn';
  code?: number | null;
  attempts: number;
}

/** One target's row: `forge notify test` prints these, and they become notified / notify-failed events. */
export interface TargetResult extends DeliveryResult {
  event: NotifyEvent;
  target: 'webhook' | 'command';
  host?: string;
  format?: 'json' | 'slack';
}

/** What the payload says about the job, read from job.json by the sender itself. */
export interface NotifyContext {
  job: string | null;
  title: string | null;
  stage: string | null;
  prUrl: string | null;
  reason: ReasonCode;
}

const TITLE_MAX = 200;
const HEADER_MAX = 150;

/**
 * Control characters become spaces and bidi controls are dropped (a hostile title can't reorder how
 * it displays), then trimmed and cut to `max` code points, ending in … when cut.
 */
export function cleanText(text: unknown, max: number): string {
  const plain = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  const chars = Array.from(plain.trim());
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The running dashboard's pipeline page when that is a loopback http URL, else the configured port's. */
export function dashboardUrl(root: string, config: Pick<Config, 'dashboard'>): string {
  try {
    const rt = readJson(path.join(paths(root).runtime, 'dashboard.json'), null);
    if (typeof rt?.url === 'string') {
      const u = new URL(rt.url);
      if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return `${u.origin}/#/pipeline`;
    }
  } catch {}
  const port = Number(config?.dashboard?.port);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 7400}/#/pipeline`;
}

const SEGMENT = '[A-Za-z0-9_.-]+';
const PR_PATHS = [new RegExp(`^/${SEGMENT}/${SEGMENT}/pull/[1-9][0-9]*$`), new RegExp(`^(?:/${SEGMENT}){2,}/-/merge_requests/[1-9][0-9]*$`)];

/**
 * The PR url only when it is a GitHub pull request or GitLab merge request URL, else null. job.json is
 * agent-writable, so any other https value could put a link of an agent's choosing into a team channel.
 */
function prLink(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return PR_PATHS.some((re) => re.test(u.pathname)) ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

export function buildPayload(event: NotifyEvent, ctx: NotifyContext, dashboard: string, at = new Date().toISOString()): NotifyPayload {
  return {
    event,
    job: ctx.job,
    title: ctx.title === null ? null : cleanText(ctx.title, TITLE_MAX),
    stage: ctx.stage,
    reason: REASONS[ctx.reason],
    url: prLink(ctx.prUrl),
    dashboardUrl: dashboard,
    at,
  };
}

/** Slack's mrkdwn escapes; plain_text needs none, but the notification fallback is mrkdwn. */
const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Block Kit (format: slack): every variable string sits in a plain_text object, so a title can't mention or link. */
export function slackPayload(p: NotifyPayload): Record<string, unknown> {
  const label = LABELS[p.event];
  const headline = p.title ? `${label}: ${p.title}` : label;
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: cleanText(headline, HEADER_MAX), emoji: false } },
    { type: 'section', text: { type: 'plain_text', text: p.reason, emoji: false } },
    { type: 'context', elements: [{ type: 'plain_text', text: `${p.job ?? '-'} · ${p.stage ?? '-'} · ${p.dashboardUrl}`, emoji: false }] },
  ];
  if (p.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open PR', emoji: false }, url: p.url }] });
  return { text: slackEscape(`Forge ${headline}`), blocks };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error class of a fetch that threw: redirect, timeout or network. Never its message, which can quote the URL. */
function fetchError(e: unknown): 'redirect' | 'timeout' | 'network' {
  const err = e as { name?: string; cause?: { message?: string; name?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError') return 'timeout';
  if (/redirect/i.test(String(err?.cause?.message ?? ''))) return 'redirect';
  return 'network';
}

/**
 * POSTs `body` once, and once more after `retryDelayMs` on a network error, timeout, 429 or 5xx.
 * A redirect is an error (redirect: 'error'), so a 3xx can't send the payload to another host.
 */
async function deliverWebhook(hook: Pick<NotifyWebhook, 'url'>, body: string, opts: { timeoutMs?: number; retryDelayMs?: number } = {}): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  let last: DeliveryResult = { ok: false, error: 'network', attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      // The body is never read: an endpoint's reply is not ours to log.
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      last = { ok: false, error: 'http', status: res.status, attempts: attempt };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      const error = fetchError(e);
      last = { ok: false, error, attempts: attempt };
      if (error === 'redirect') return last;
    }
    if (attempt === 1) await sleep(retryDelayMs);
  }
  return last;
}

/** The environment variable each {placeholder} reads. */
const PLACEHOLDER_ENV = {
  event: 'FORGE_NOTIFY_EVENT',
  job: 'FORGE_NOTIFY_JOB',
  title: 'FORGE_NOTIFY_TITLE',
  url: 'FORGE_NOTIFY_URL',
  stage: 'FORGE_NOTIFY_STAGE',
  reason: 'FORGE_NOTIFY_REASON',
  dashboardUrl: 'FORGE_NOTIFY_DASHBOARD_URL',
} as const;

/**
 * The command as the shell sees it: each {placeholder} becomes a quoted reference to its variable,
 * never the value, so a title such as `$(touch x)` or `'; rm -rf ~; '` reaches the script as text.
 */
export function commandSource(template: string): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(PLACEHOLDER_ENV, k) ? `"$${PLACEHOLDER_ENV[k as keyof typeof PLACEHOLDER_ENV]}"` : m));
}

/** The variables the command's environment carries: empty strings for nulls. */
function commandEnv(p: NotifyPayload): Record<string, string> {
  return {
    FORGE_NOTIFY_EVENT: p.event,
    FORGE_NOTIFY_JOB: p.job ?? '',
    FORGE_NOTIFY_TITLE: p.title ?? '',
    FORGE_NOTIFY_URL: p.url ?? '',
    FORGE_NOTIFY_STAGE: p.stage ?? '',
    FORGE_NOTIFY_REASON: p.reason,
    FORGE_NOTIFY_DASHBOARD_URL: p.dashboardUrl,
  };
}

/** Runs notify.command once under posixShell() -c in the repo root; killed after timeoutMs. Not retried. */
export function runCommand(root: string, template: string, p: NotifyPayload, opts: { timeoutMs?: number } = {}): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const done = (r: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Detached into its own group, so a timeout kills whatever the script started too.
      child = spawn(posixShell(), ['-c', commandSource(template)], { cwd: root, env: { ...process.env, ...commandEnv(p) }, stdio: 'ignore', detached: process.platform !== 'win32' });
    } catch {
      return resolve({ ok: false, error: 'spawn', attempts: 1 });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', () => done({ ok: false, error: 'spawn', attempts: 1 }));
    child.on('exit', (code) => {
      if (timedOut) return done({ ok: false, error: 'timeout', attempts: 1 });
      done(code === 0 ? { ok: true, attempts: 1 } : { ok: false, error: 'exit', code, attempts: 1 });
    });
  });
}

/** The first event in `events` (most specific first) that `hook` subscribes to, or null. */
function eventFor(hook: NotifyWebhook, events: readonly NotifyEvent[]): NotifyEvent | null {
  return events.find((e) => !hook.events || hook.events.includes(e)) ?? null;
}

export interface DeliverOptions {
  /** `forge notify test`: every webhook regardless of its events, and nothing recorded. */
  test?: boolean;
  timeoutMs?: number;
  retryDelayMs?: number;
  commandTimeoutMs?: number;
}

/** Delivers to every target at once and records one event per target; never throws. */
export async function deliver(root: string, config: Config, events: readonly NotifyEvent[], ctx: NotifyContext, opts: DeliverOptions = {}): Promise<TargetResult[]> {
  if (!events.length) return [];
  const dash = dashboardUrl(root, config);
  const at = new Date().toISOString();
  const tasks: Promise<TargetResult>[] = [];
  for (const hook of validWebhooks(config)) {
    const event = opts.test ? events[0] : eventFor(hook, events);
    if (!event) continue;
    const format = hook.format ?? 'json';
    const host = webhookHost(hook.url) ?? '';
    const payload = buildPayload(event, ctx, dash, at);
    const body = JSON.stringify(format === 'slack' ? slackPayload(payload) : payload);
    tasks.push(
      deliverWebhook(hook, body, { timeoutMs: opts.timeoutMs, retryDelayMs: opts.retryDelayMs })
        .catch((): DeliveryResult => ({ ok: false, error: 'network', attempts: 1 }))
        .then((r) => ({ event, target: 'webhook' as const, host, format, ...r })),
    );
  }
  const command = validCommand(config);
  if (command) {
    const payload = buildPayload(events[0], ctx, dash, at);
    tasks.push(
      runCommand(root, command, payload, { timeoutMs: opts.commandTimeoutMs })
        .catch((): DeliveryResult => ({ ok: false, error: 'spawn', attempts: 1 }))
        .then((r) => ({ event: events[0], target: 'command' as const, ...r })),
    );
  }
  const results = await Promise.all(tasks);
  if (!opts.test) for (const r of results) record(root, ctx.job, r);
  return results;
}

/** The event a result becomes: host only, never the URL or the command. */
function resultEvent(r: TargetResult): { type: 'notified' | 'notify-failed'; data: Record<string, unknown> } {
  const where = r.target === 'webhook' ? { host: r.host, format: r.format } : {};
  if (r.ok) return { type: 'notified', data: { event: r.event, target: r.target, ...where, ...(r.status !== undefined ? { status: r.status } : {}), attempts: r.attempts } };
  return {
    type: 'notify-failed',
    data: {
      event: r.event,
      target: r.target,
      ...(r.target === 'webhook' ? { host: r.host } : {}),
      error: r.error,
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.code !== undefined ? { code: r.code } : {}),
      attempts: r.attempts,
    },
  };
}

/** The repo-level record of notifications with no job (a pool-wide daemon stop). */
export const notifyLogFile = (root: string): string => path.join(paths(root).runtime, 'notify.jsonl');

function record(root: string, job: string | null, r: TargetResult): void {
  const { type, data } = resultEvent(r);
  try {
    // A job (or repo) deleted while delivery ran gets no record, rather than a recreated directory.
    if (job) return exists(path.join(jobDir(root, job), 'job.json')) ? logEvent(root, job, type, data) : undefined;
    if (!exists(paths(root).dir)) return;
    const file = notifyLogFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The runtime dir is agent-writable: a planted symlink or FIFO is refused, never followed.
    const fd = openAppend(file);
    try {
      fs.writeSync(fd, JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), type, ...data }) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

/** The context `forge notify send` builds: the job's own title, stage and PR url, read here, not passed in. */
export function contextFor(root: string, job: string | null, reason: ReasonCode): NotifyContext {
  if (!job) return { job: null, title: null, stage: null, prUrl: null, reason };
  const j = loadJob(root, job);
  return { job: j.id, title: j.title, stage: j.stage, prUrl: j.pr?.url ?? null, reason };
}

/** What a transition notifies about, most specific first, with its reason code; null for nothing. */
export function transitionEvents(before: TransitionSide | null, after: TransitionSide, job: Pick<Job, 'kind' | 'pr'>): { events: NotifyEvent[]; reason: ReasonCode } | null {
  if (job.kind === 'eval') return null;
  const b: Partial<TransitionSide> = before ?? {};
  if (after.state === 'waiting' && (NOTIFY_GATES as readonly unknown[]).includes(after.waitingOn) && (b.state !== 'waiting' || b.waitingOn !== after.waitingOn)) {
    const gate = after.waitingOn as (typeof NOTIFY_GATES)[number];
    return gate === 'budget' ? { events: ['budget-exceeded', 'gate'], reason: 'budget' } : { events: ['gate'], reason: gate };
  }
  if (after.state === 'failed' && b.state !== 'failed') return { events: ['job-failed'], reason: 'failed' };
  if (after.state === 'done' && b.state !== 'done' && job.pr?.number) return { events: ['pr-merged'], reason: 'pr-merged' };
  return null;
}

/** queueNotify's signature, so the daemon can take a stand-in in tests. */
export type QueueNotify = (root: string, events: readonly NotifyEvent[], opts: { job?: string | null; reason: ReasonCode }) => boolean;

/**
 * Hands delivery to a detached `forge notify send` child and returns at once. Does nothing (no
 * child, no event) when notify is unconfigured, the job is an eval, or there is nothing to send.
 * Never throws: a notification must not fail the command that triggered it.
 */
export const queueNotify: QueueNotify = (root, events, opts) => {
  try {
    if (!events.length) return false;
    const { config } = loadConfig(root);
    if (!notifyConfigured(config)) return false;
    if (opts.job && loadJob(root, opts.job).kind === 'eval') return false;
    const args = [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'notify', 'send', '--events', events.join(','), ...(opts.job ? ['--job', opts.job] : []), '--reason', opts.reason];
    const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, FORGE_ROOT: root } });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
};

/** A best-effort HEAD: any HTTP answer means reachable. `redirect: manual`, so a 3xx is an answer, not a hop. */
async function probe(url: string, timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return `reachable (HTTP ${res.status})`;
  } catch (e) {
    const why = fetchError(e);
    return `unreachable (${why === 'timeout' ? 'timeout' : 'network'})`;
  }
}

/**
 * forge doctor's notify checks: one per configured webhook (an invalid entry fails with its
 * problem; a reachable or unreachable one is ok, unreachable and plain http with a warning), and
 * `notify command` when one is set, which is never run. No webhooks: no check and no network.
 */
export async function notifyChecks(config: Pick<Config, 'notify'>, opts: { timeoutMs?: number } = {}): Promise<DoctorCheck[]> {
  const hooks: unknown[] = Array.isArray(config?.notify?.webhooks) ? config.notify.webhooks : [];
  const checks = await Promise.all(
    hooks.map(async (hook, i): Promise<DoctorCheck> => {
      const host = hook && typeof hook === 'object' ? webhookHost((hook as { url?: unknown }).url) : null;
      const name = `notify webhook ${i}${host ? ` (${host})` : ''}`;
      const problem = webhookProblem(hook);
      if (problem) return { name, ok: false, detail: problem };
      const url = (hook as NotifyWebhook).url;
      const reach = await probe(url, opts.timeoutMs ?? 5000);
      const plain = new URL(url).protocol === 'http:';
      const warn = plain || reach.startsWith('unreachable');
      return { name, ok: true, detail: plain ? `plain http, loopback only; ${reach}` : reach, ...(warn ? { warn: true } : {}) };
    }),
  );
  if (config?.notify?.command !== null && config?.notify?.command !== undefined) {
    const problem = commandProblem(config.notify.command);
    checks.push({ name: 'notify command', ok: !problem, detail: problem ?? 'set' });
  }
  return checks;
}

// jobs.ts sits below this module, so it can't call queueNotify itself: it calls this hook once per
// transition instead. Every `forge` process loads this module (lib/cli/main.ts imports commands/notify.ts),
// so no state change goes unnoticed.
onTransition((root, job, from, to) => {
  const n = transitionEvents(from, to, job);
  if (n) queueNotify(root, n.events, { job: job.id, reason: n.reason });
});
