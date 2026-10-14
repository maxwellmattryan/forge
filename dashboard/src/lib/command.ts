// The command bar's grammar, completions, keyboard rule and request mapping: plain functions over
// the dashboard's state, so node:test can pin them. CommandBar.svelte holds only markup.
import type { PostJobBody, RequestType, StateJob, TrackerItem } from './types.ts';
import { buildRequest, needsHuman } from './view.ts';
import type { RequestInput } from './view.ts';

/** First words the bar understands, in the order the empty bar lists them (all of them: the empty list is where they are discovered). */
export const VERBS = ['next', 'issue', 'approve', 'answer', 'revise', 'rework', 'cancel', 'sync', 'retro'] as const;
export type Verb = (typeof VERBS)[number];

export const JOB_VERBS = ['approve', 'revise', 'rework', 'answer', 'cancel'] as const;
export type JobVerb = (typeof JOB_VERBS)[number];

const VERB_TYPE: Record<JobVerb, RequestType> = { approve: 'approve', revise: 'revise-spec', rework: 'rework', answer: 'answer', cancel: 'cancel' };
const NEEDS_NOTE: ReadonlySet<JobVerb> = new Set(['revise', 'answer']);
const MAX_SUGGESTIONS = 8;
const MAX_N = 16;
/** lib/issue-link.ts REF: duplicated, because the dashboard never imports engine modules. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface CommandCtx {
  jobs: StateJob[];
  /** /api/backlog items, or null when not loaded (or it failed): ref completion is then empty. */
  backlog: TrackerItem[] | null;
  tracker: string;
}

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'free'; text: string }
  | { kind: 'partial'; verb: Verb; arg: string }
  | { kind: 'next'; n: number | null }
  | { kind: 'sync' | 'retro' }
  | { kind: 'job'; verb: JobVerb; job: string; note: string }
  | { kind: 'issue'; ref: string };

export type Suggestion =
  /** `verbLike`: the text starts with a command word but matched no command, so the hint says it becomes a job. */
  | { kind: 'run-job'; verbLike: boolean }
  | { kind: 'run-command' }
  | { kind: 'verb'; verb: Verb; insert: string }
  | { kind: 'job'; job: StateJob; insert: string }
  | { kind: 'ref'; item: TrackerItem; insert: string };

const isVerb = (w: string): w is Verb => (VERBS as readonly string[]).includes(w);
const isJobVerb = (w: string): w is JobVerb => (JOB_VERBS as readonly string[]).includes(w);
const openJob = (j: StateJob): boolean => j.state !== 'done' && j.state !== 'cancelled';
const CLOSED = new Set(['done', 'dropped', 'closed', 'cancelled', 'in-progress']);
const openItem = (i: TrackerItem): boolean => !i.claimedBy && !CLOSED.has(String(i.status ?? '').toLowerCase());

/** The input without a leading `/forge ` or `/`. */
function unprefixed(input: string): string {
  const s = input.replace(/^\s+/, '');
  if (/^\/forge(?::forge)?(?:\s|$)/i.test(s)) return s.replace(/^\/forge(?::forge)?\s*/i, '');
  return s.startsWith('/') ? s.slice(1) : s;
}

/** The first word, lowercased, what follows it, and whether a space was typed after it. */
function split(input: string): { word: string; rest: string; spaced: boolean } {
  const s = unprefixed(input);
  const m = /^(\S*)(\s*)([\s\S]*)$/.exec(s)!;
  return { word: m[1].toLowerCase(), rest: m[3], spaced: m[2].length > 0 };
}

function issueRef(raw: string): string {
  return raw.replace(/^#/, '');
}

/** Classifies the bar's input: a complete command, a verb still being completed, or free text (a new job). */
export function parseCommand(input: string, ctx: CommandCtx): Parsed {
  const s = unprefixed(input);
  if (!s.trim()) return { kind: 'empty' };
  const free: Parsed = { kind: 'free', text: input.trim() };
  const { word, rest } = split(input);
  if (!isVerb(word)) return free;
  const arg = rest.trim();
  if (word === 'next') {
    if (!arg) return { kind: 'next', n: null };
    const n = /^\d+$/.test(arg) ? Number(arg) : NaN;
    return n >= 1 && n <= MAX_N ? { kind: 'next', n } : free;
  }
  if (word === 'sync' || word === 'retro') return arg ? free : { kind: word };
  const first = arg.split(/\s+/)[0] ?? '';
  const after = arg.slice(first.length).trim();
  if (isJobVerb(word)) {
    if (!first) return { kind: 'partial', verb: word, arg: '' };
    const open = ctx.jobs.filter(openJob);
    if (open.some((j) => j.id === first)) return { kind: 'job', verb: word, job: first, note: after };
    if (!after && open.some((j) => j.id.startsWith(first))) return { kind: 'partial', verb: word, arg: first };
    return free;
  }
  // issue <ref>
  if (!first) return { kind: 'partial', verb: word, arg: '' };
  if (after) return free;
  const ref = issueRef(first);
  const known = (ctx.backlog ?? []).some((i) => String(i.ref) === ref);
  if (REF.test(ref) && (known || (ctx.tracker === 'github' && /^\d+$/.test(ref)))) return { kind: 'issue', ref };
  if (refMatches(ctx, ref).length) return { kind: 'partial', verb: word, arg: first };
  return free;
}

/** Open, unclaimed backlog items matching by ref prefix or a title substring. */
function refMatches(ctx: CommandCtx, raw: string): TrackerItem[] {
  const q = issueRef(raw).toLowerCase();
  return (ctx.backlog ?? []).filter((i) => openItem(i) && (String(i.ref).toLowerCase().startsWith(q) || String(i.title ?? '').toLowerCase().includes(q)));
}

const runnable = (p: Parsed): boolean => p.kind !== 'empty' && p.kind !== 'partial';

/** The bar's options, at most 8 once something is typed (all the verbs on an empty bar): the Run option when there is something to run, then completions. */
export function suggest(input: string, ctx: CommandCtx): Suggestion[] {
  const p = parseCommand(input, ctx);
  const out: Suggestion[] = [];
  const { word, rest, spaced } = split(input);
  if (p.kind === 'empty') return VERBS.map((verb) => ({ kind: 'verb', verb, insert: `${verb} ` }));
  const runJob: Suggestion = { kind: 'run-job', verbLike: isVerb(word) };
  const verbs: Suggestion[] = !spaced ? VERBS.filter((v) => v.startsWith(word) && !(v === word && runnable(p))).map((verb) => ({ kind: 'verb', verb, insert: `${verb} ` })) : [];
  if (p.kind === 'free' && verbs.length) out.push(...verbs, runJob);
  else if (runnable(p)) out.push(p.kind === 'free' ? runJob : { kind: 'run-command' }, ...verbs);
  else out.push(...verbs);
  if (p.kind === 'partial' && spaced && isJobVerb(p.verb)) {
    const arg = p.arg.toLowerCase();
    const open = ctx.jobs.filter((j) => openJob(j) && j.id.toLowerCase().startsWith(arg));
    const urgent = (j: StateJob) => needsHuman(j) || j.state === 'failed' || j.state === 'blocked';
    for (const job of [...open.filter(urgent), ...open.filter((j) => !urgent(j))]) out.push({ kind: 'job', job, insert: `${p.verb} ${job.id} ` });
  }
  if (p.kind === 'partial' && spaced && p.verb === 'issue') {
    for (const item of refMatches(ctx, rest.trim())) out.push({ kind: 'ref', item, insert: `issue ${item.ref}` });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/** What submitting a parse sends: POST /api/jobs, or a /api/requests body built by buildRequest. */
export function commandRequest(p: Parsed): { kind: 'job'; body: PostJobBody } | { kind: 'request'; input: RequestInput } | { error: string } {
  let input: RequestInput;
  switch (p.kind) {
    case 'free':
      return { kind: 'job', body: { text: p.text } };
    case 'next':
      input = { type: 'next', args: p.n ? { n: p.n } : {} };
      break;
    case 'sync':
    case 'retro':
      input = { type: p.kind };
      break;
    case 'job':
      input = { type: VERB_TYPE[p.verb], job: p.job, note: p.note, needsNote: NEEDS_NOTE.has(p.verb) };
      break;
    case 'issue':
      input = { type: 'run', ref: p.ref };
      break;
    default:
      return { error: 'Finish the command first.' };
  }
  const built = buildRequest(input);
  return 'error' in built ? built : { kind: 'request', input };
}

/** What a keydown on the window should do with the bar. */
export interface CommandKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  open: boolean;
  /** Settings is open: the bar never opens over it. */
  settingsOpen: boolean;
  /** A held key's auto-repeat. */
  repeat?: boolean;
  /** Part of an IME composition. */
  composing?: boolean;
}

/**
 * `open` for Cmd-K or Ctrl-K (even inside a field, since it is a modifier chord), `close` for Escape
 * while open, else null. Cmd/Ctrl-K while already open is `open` too, so the browser's own Ctrl-K
 * (its search bar) never fires over the bar.
 */
export function commandKey(e: CommandKeyInput): 'open' | 'close' | null {
  if (e.open && e.key === 'Escape') return 'close';
  if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || e.composing) return null;
  if (e.settingsOpen) return null;
  return 'open';
}

/** The shortcut hint: `⌘K` on Apple platforms, `Ctrl K` elsewhere. */
export const shortcutLabel = (platform: string): string => (/mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K');

/** Why a partial command has no options, for the visible line in place of the list; null when it has some. */
export function emptyReason(p: Parsed, options: Suggestion[], backlogError: string | null | undefined, ctx: CommandCtx): 'noJobs' | 'noItems' | 'backlogLoading' | 'backlogFailed' | null {
  if (options.length || p.kind !== 'partial') return null;
  if (p.verb !== 'issue') return isJobVerb(p.verb) ? 'noJobs' : null;
  if (backlogError) return 'backlogFailed';
  return ctx.backlog === null ? 'backlogLoading' : 'noItems';
}

/** The toast after a command: a job verb names its job. */
export const commandQueuedMessage = (type: string, job: string | null | undefined, daemon: boolean): string => {
  const what = job ? `"${type}" for ${job}` : `"${type}"`;
  return daemon ? `Queued ${what}. The daemon picks it up.` : `Queued ${what}. Your orchestrator session picks it up (/forge requests).`;
};

/** The toast after POST /api/jobs. */
export const createdMessage = (id: string, daemon: boolean): string =>
  daemon ? `Created ${id}. The daemon picks it up.` : `Created ${id}. Start the daemon, or run /forge requests in Claude Code.`;
