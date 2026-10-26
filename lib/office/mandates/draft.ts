// A goal mandate's milestone draft and its drafting runs' records: the draft rules (draftProblems), the
// stored `.forge/runtime/mandates/<id>/draft.json` (readDraft, recordDraft), the drafter's staging file
// under the office session's worktrees root, the draft requests for a mandate, the spend ledger
// (`ledger.jsonl`), and the status `forge mandate draft show` prints. docs/architecture/foreman.md › Intake.
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { worktreeRoot } from '#core/config/load.ts';
import { checkIssueRef } from '#core/job/issue-ref.ts';
import { listRequests } from '#core/job/requests.ts';
import { openAppend } from '#core/job/session-files.ts';
import { logRepoEvent } from '#core/job/store.ts';
import { confinedDir, readRegular, readRegularText, writeJsonAtomic } from '#core/os/fs.ts';
import { isMap } from '#core/shape.ts';
import { visibleText } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { DRAFT_SCHEMA_VERSION, DRAFT_STEPS } from '#core/versions/draft.ts';
import { EVENT_SCHEMA_VERSION } from '#core/versions/event.ts';
import { runSteps } from '#core/versions/steps.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { estimateCost } from '#integrations/claude/pricing.ts';
import { hasUsage } from '#engine/metrics/spend.ts';
import { importClaudeCodeTranscript } from '#engine/metrics/usage.ts';
import { roster } from '#engine/pipeline/roster.ts';
import { foremanEnabled } from '#engine/pipeline/moves/foreman-gates.ts';
import { mandateDir, withMandatesLock } from './store.ts';
import type { Config, ForgeRequest } from '#core/types.ts';
import type { Draft, DraftBody, DraftIssue, DraftSpend, DraftStatus, Mandate, ReadDraft } from './types.ts';

/** The staging file and draft.json: 30 issues of a few KiB each fit with room to spare. */
export const DRAFT_MAX_BYTES = 256 * 1024;
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROBLEMS = 20;
const ISSUES_MAX = 30;
const WAVES_MAX = 20;
const FILES_MAX = 20;
const EXIT_CRITERIA_MAX = 10;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REQUEST_ID = /^\d+-[A-Za-z0-9]+$/;
// One line: no control character at all. Many lines: LF and TAB only. Neither may hold a line or
// paragraph separator (built from code points: a literal one ends a regex literal).
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const ONE_LINE_CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]`);
const LINES_CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${SEPARATORS}]`);
const TOP_KEYS = ['milestone', 'issues'];
const MILESTONE_KEYS = ['title', 'exitCriteria'];
const ISSUE_KEYS = ['key', 'title', 'why', 'whatToDo', 'done', 'stat', 'wave', 'dependsOn', 'files', 'existing'];
const EXISTING_KEYS = ['ref', 'action'];
const HEADER_KEYS = ['schemaVersion', 'mandate', 'request', 'recordedAt'];

const show = (v: unknown): string => String(JSON.stringify(String(v))).slice(0, 80);

/** Why `v` is not 1-`max` characters of visible text, on one line or (`lines`) on lines; null when it is. */
function textProblem(what: string, v: unknown, max: number, lines = false): string | null {
  if (typeof v !== 'string' || !v.trim() || v.length > max) return `${what} must be 1-${max} characters of text`;
  if ((lines ? LINES_CONTROL : ONE_LINE_CONTROL).test(v)) return lines ? `${what} may hold no control character but line feed and tab` : `${what} must be one line with no control character`;
  if (visibleText(v).removed > 0) return `${what} holds hidden characters or HTML comments`;
  return null;
}

/** The keys of a map that are not `allowed`, and the allowed keys it lacks, as problems. */
function keyProblems(where: string, m: Record<string, unknown>, allowed: string[]): string[] {
  const unknown = Object.keys(m).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown key ${show(k)}`);
  return [...unknown, ...allowed.filter((k) => !Object.hasOwn(m, k)).map((k) => `${where}: no ${k}`)];
}

/** Why a repo path in `files` is refused: absolute, an option, `..`, a backslash or hidden text. */
function fileProblem(f: unknown): string | null {
  if (typeof f !== 'string' || !f || f.length > 200) return 'must be 1-200 characters';
  if (f.startsWith('/') || f.startsWith('-')) return 'must be repo-relative, not start with / or -';
  if (f.includes('\\') || f.split('/').includes('..')) return 'may hold no .. segment and no backslash';
  if (ONE_LINE_CONTROL.test(f) || visibleText(f).removed > 0) return 'may hold no control or hidden character';
  return null;
}

/** Equal, or one a `/`-prefix of the other once trailing slashes go. */
const overlaps = (a: string, b: string): boolean => {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
};

/** How an `existing.ref` is checked: against the repo's tracker on record, its stored form on read. */
export type RefCheck = (raw: unknown) => { ref: string } | { error: string };

/** A ref as `checkIssueRef` takes it for this repo's tracker, so `12` is stored as `<slug>#12` under github. */
export function trackerRefCheck(root: string, config: Config): RefCheck {
  const tracker = config.tracker?.kind ?? 'local';
  const slug = tracker === 'github' ? localRepoSlug(root, config) : null;
  return (raw) => checkIssueRef(raw, { tracker, slug });
}

/** A ref already in its stored form: what readDraft accepts. */
const storedRefCheck: RefCheck = (raw) => {
  const r = checkIssueRef(raw, { tracker: '', slug: null });
  return 'ref' in r && r.ref === raw ? r : { error: `${show(raw)} is not a stored issue ref` };
};

/** Every problem of one issue on its own: keys, text, wave, files and the shape of dependsOn. */
function issueProblems(it: Record<string, any>, i: number, label: string, keys: Set<string>): string[] {
  const problems = keyProblems(label, it, ISSUE_KEYS);
  if (typeof it.key !== 'string' || !KEY.test(it.key)) problems.push(`issues[${i}]: key ${show(it.key)} must be lowercase letters, digits and -, at most 40, not starting with -`);
  else if (keys.has(it.key)) problems.push(`issue key ${it.key} is used twice`);
  else keys.add(it.key);
  for (const [k, max, lines] of [['title', 200, false], ['stat', 100, false], ['why', 2000, true], ['whatToDo', 4000, true], ['done', 2000, true]] as const) {
    if (!Object.hasOwn(it, k)) continue;
    const p = textProblem(`${label}: ${k}`, it[k], max, lines);
    if (p) problems.push(p);
  }
  if (!Number.isInteger(it.wave) || it.wave < 1 || it.wave > WAVES_MAX) problems.push(`${label}: wave must be an integer 1-${WAVES_MAX}`);
  if (!Array.isArray(it.files) || it.files.length < 1 || it.files.length > FILES_MAX) problems.push(`${label}: files must be a list of 1-${FILES_MAX} repo paths`);
  else
    for (const f of it.files) {
      const p = fileProblem(f);
      if (p) problems.push(`${label}: file ${show(f)} ${p}`);
    }
  if (!Array.isArray(it.dependsOn)) problems.push(`${label}: dependsOn must be a list of issue keys`);
  return problems;
}

/** The milestone's problems: its keys, a one-line title and 1-10 one-line exit criteria. */
function milestoneProblems(ms: unknown): string[] {
  if (!isMap(ms)) return ['milestone must be an object with title and exitCriteria'];
  const problems = keyProblems('milestone', ms, MILESTONE_KEYS);
  const t = textProblem('milestone.title', ms.title, 200);
  if (t) problems.push(t);
  if (!Object.hasOwn(ms, 'exitCriteria')) return problems;
  const ec = ms.exitCriteria;
  if (!Array.isArray(ec) || ec.length < 1 || ec.length > EXIT_CRITERIA_MAX) return [...problems, `milestone.exitCriteria must be a list of 1-${EXIT_CRITERIA_MAX} entries`];
  ec.forEach((c, i) => {
    const p = textProblem(`milestone.exitCriteria[${i}]`, c, 300);
    if (p) problems.push(p);
  });
  return problems;
}

/**
 * Every rule a drafter's JSON breaks (docs/architecture/foreman.md › Intake), and the draft with each
 * `existing.ref` in its stored form when it breaks none. Exactly the documented keys at every level; text
 * on one line or on lines, visible, bounded; 1-30 issues with unique keys; waves 1…max with no gap;
 * dependencies only on earlier waves; repo-relative files that no two issues in one wave share.
 */
export function draftProblems(raw: unknown, refOf: RefCheck): { problems: string[]; draft: DraftBody | null } {
  if (!isMap(raw)) return { problems: ['the draft must be a JSON object with milestone and issues'], draft: null };
  const problems = keyProblems('the draft', raw, TOP_KEYS);
  if (Object.hasOwn(raw, 'milestone')) problems.push(...milestoneProblems(raw.milestone));
  const issues = raw.issues;
  if (!Object.hasOwn(raw, 'issues')) return { problems, draft: null };
  if (!Array.isArray(issues) || issues.length < 1 || issues.length > ISSUES_MAX) {
    problems.push(`issues must be a list of 1-${ISSUES_MAX} issues (got ${Array.isArray(issues) ? issues.length : typeof issues})`);
    return { problems, draft: null };
  }
  const label = (i: number) => (isMap(issues[i]) && typeof issues[i].key === 'string' && KEY.test(issues[i].key) ? `issue ${issues[i].key}` : `issues[${i}]`);
  const keys = new Set<string>();
  const waveOf = new Map<string, number>();
  issues.forEach((it, i) => {
    if (!isMap(it)) return void problems.push(`issues[${i}] must be an object`);
    problems.push(...issueProblems(it, i, label(i), keys));
    if (typeof it.key === 'string' && Number.isInteger(it.wave) && !waveOf.has(it.key)) waveOf.set(it.key, it.wave as number);
  });
  // Waves, dependencies, file overlaps and existing refs need every issue's key and wave first.
  const used = [...new Set(waveOf.values())];
  const max = used.length ? Math.max(...used) : 0;
  for (let w = 1; w <= max; w++) if (!used.includes(w)) problems.push(`waves must run 1 to ${max} with no gap (no issue in wave ${w})`);
  const refs = new Map<string, string>();
  const stored: DraftIssue[] = [];
  issues.forEach((it, i) => {
    if (!isMap(it)) return;
    const own = typeof it.key === 'string' ? waveOf.get(it.key) : undefined;
    const seen = new Set<unknown>();
    for (const d of Array.isArray(it.dependsOn) ? it.dependsOn : []) {
      if (seen.has(d)) problems.push(`${label(i)} lists dependency ${show(d)} twice`);
      seen.add(d);
      if (d === it.key) problems.push(`${label(i)} depends on itself`);
      else if (typeof d !== 'string' || !keys.has(d)) problems.push(`${label(i)} depends on unknown issue ${show(d)}`);
      else if (own !== undefined && (waveOf.get(d) ?? 0) >= own) problems.push(`${label(i)} (wave ${own}) depends on ${d} in wave ${waveOf.get(d)}: a dependency must sit in an earlier wave`);
    }
    let existing: DraftIssue['existing'] = null;
    const e = it.existing;
    if (Object.hasOwn(it, 'existing') && e !== null) {
      if (!isMap(e)) problems.push(`${label(i)}: existing must be null or {ref, action}`);
      else {
        problems.push(...keyProblems(`${label(i)}: existing`, e, EXISTING_KEYS));
        if (e.action !== 'reuse' && e.action !== 'amend') problems.push(`${label(i)}: existing.action must be reuse or amend`);
        const r = refOf(e.ref);
        if ('error' in r) problems.push(`${label(i)}: existing.ref: ${r.error}`);
        else if (refs.has(r.ref)) problems.push(`${label(i)} and issue ${refs.get(r.ref)} both name existing issue ${r.ref}`);
        else {
          refs.set(r.ref, String(it.key));
          existing = { ref: r.ref, action: e.action as 'reuse' | 'amend' };
        }
      }
    }
    stored.push({ ...(it as unknown as DraftIssue), existing });
  });
  for (let a = 0; a < issues.length; a++) {
    for (let b = a + 1; b < issues.length; b++) {
      const x = issues[a];
      const y = issues[b];
      if (!isMap(x) || !isMap(y) || !Number.isInteger(x.wave) || x.wave !== y.wave || !Array.isArray(x.files) || !Array.isArray(y.files)) continue;
      const strings = (l: unknown[]) => l.filter((f): f is string => typeof f === 'string');
      const hit = strings(x.files).flatMap((f) => strings(y.files).filter((g) => overlaps(f, g)).map((g) => [f, g]))[0];
      if (hit) problems.push(`${label(a)} and ${label(b)} in wave ${x.wave} both touch ${show(hit[0])}${hit[0] === hit[1] ? '' : ` and ${show(hit[1])}`}: issues in one wave must not share files`);
    }
  }
  if (problems.length) return { problems, draft: null };
  const ms = raw.milestone as Record<string, any>;
  return { problems, draft: { milestone: { title: ms.title, exitCriteria: [...ms.exitCriteria] }, issues: stored } };
}

/** A mandate's draft.json. */
export const draftFile = (root: string, id: string): string => path.join(mandateDir(root, id), 'draft.json');
const ledgerFile = (root: string, id: string): string => path.join(mandateDir(root, id), 'ledger.jsonl');

/**
 * A mandate's draft.json, or null when there is none, or `{problem}` when it can't be read safely: a
 * link, not a regular file, over 256 KiB, not JSON, a newer schemaVersion, a header that doesn't fit,
 * or a draft that breaks the rules.
 */
export function readDraft(root: string, id: string): ReadDraft {
  const bytes = readRegular(draftFile(root, id), DRAFT_MAX_BYTES);
  if (typeof bytes === 'string') return bytes === 'unreadable (ENOENT)' ? null : { problem: bytes };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: 'not JSON' };
  }
  if (!isMap(raw)) return { problem: 'not a JSON object' };
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1) return { problem: 'schemaVersion must be a positive integer' };
  if ((v as number) > DRAFT_SCHEMA_VERSION) return { problem: `written by a newer Forge (schemaVersion ${v}); update the plugin` };
  const d = runSteps(DRAFT_STEPS, raw, v as number);
  const missing = HEADER_KEYS.find((k) => !Object.hasOwn(d, k));
  if (missing !== undefined) return { problem: `no ${missing}` };
  const { schemaVersion: _v, mandate, request, recordedAt, ...body } = d;
  if (mandate !== id) return { problem: `its mandate ${show(mandate)} differs from ${id}` };
  if (typeof request !== 'string' || !REQUEST_ID.test(request)) return { problem: `request ${show(request)} is not a request id` };
  if (typeof recordedAt !== 'string' || recordedAt.length > 64 || !Number.isFinite(Date.parse(recordedAt))) return { problem: 'recordedAt must be an ISO time' };
  const checked = draftProblems(body, storedRefCheck);
  if (!checked.draft) return { problem: checked.problems[0] };
  return { schemaVersion: DRAFT_SCHEMA_VERSION, mandate: id, request, recordedAt, ...checked.draft };
}

/** Where the drafter writes: `<worktrees.root>/_office/drafts/<id>.json`, inside the office session's write roots. */
export const stagingFile = (root: string, config: Config, id: string): string => path.join(worktreeRoot(root, config), '_office', 'drafts', `${id}.json`);

/** The drafts dir's real path, made a level at a time; throws (exit 1) when a link or a file sits on it. */
export function draftsDir(root: string, config: Config): string {
  const base = worktreeRoot(root, config);
  fs.mkdirSync(base, { recursive: true });
  return confinedDir(base, path.join(base, '_office', 'drafts'));
}

/** The draft requests for mandate `id`, oldest first. */
export const draftRequests = (root: string, id: string): ForgeRequest[] => listRequests(root).filter((r) => r.type === 'draft' && r.args?.mandate === id);

/** `rid` when it is an in-progress draft request for mandate `id`; refused (exit 1) otherwise. Looked up in the listing: no path is built from it. */
export function boundRequest(root: string, id: string, rid: string): ForgeRequest {
  const r = draftRequests(root, id).find((x) => x.id === rid);
  if (!r || r.status !== 'in-progress') throw new ForgeError(`--request ${show(rid).slice(1, -1)} is not an in-progress draft request for mandate ${id}`, 1);
  return r;
}

/** The ledger line of one drafting run: a job event's `agent-end` shape. */
interface SpendLine {
  v: number;
  ts: string;
  type: 'agent-end';
  role: 'drafter';
  model: string | null;
  usage?: Record<string, unknown>;
  metered: boolean;
  request: string;
  agentId: string | null;
}

/** Appends one line to a mandate's ledger.jsonl, through real directories, never a planted link or FIFO. */
function appendSpend(root: string, id: string, line: SpendLine): void {
  const dir = confinedDir(root, mandateDir(root, id));
  const fd = openAppend(path.join(dir, 'ledger.jsonl'));
  try {
    fs.writeSync(fd, `${JSON.stringify(line)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/** The staging file's parsed JSON; throws (exit 1) naming why it can't be read. */
function readStaging(root: string, config: Config, id: string): unknown {
  let staging: string;
  try {
    staging = path.join(draftsDir(root, config), `${id}.json`);
  } catch (e) {
    throw new ForgeError(`the staging file can't be read: ${(e as Error).message}`, 1);
  }
  const bytes = readRegular(staging, DRAFT_MAX_BYTES);
  if (typeof bytes === 'string') throw new ForgeError(`the staging file ${staging} can't be read: ${bytes === 'unreadable (ENOENT)' ? 'it is missing' : bytes}`, 1);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ForgeError(`the staging file ${staging} is not JSON`, 1);
  }
}

/**
 * `forge mandate draft record`: under the mandates lock, the run's spend first (its ledger line stays
 * whatever happens next), then the staging file read, checked and stored as draft.json, the
 * `mandate-draft` audit event, and the staging file removed. Throws (exit 1) with every problem named
 * (at most 20) when the draft can't be stored; the previous draft.json is then untouched.
 */
export function recordDraft(
  root: string,
  config: Config,
  m: Mandate,
  request: string,
  opts: { agentId: string | null; metered: boolean },
): { ok: true; mandate: string; request: string; draft: { issues: number; waves: number; existing: number }; spend: DraftSpend; file: string } {
  return withMandatesLock(root, () => {
    const usage = opts.agentId ? importClaudeCodeTranscript(opts.agentId, {}) : null;
    const row = roster(root, config).agents.find((a) => a.role === 'drafter');
    appendSpend(root, m.id, {
      v: EVENT_SCHEMA_VERSION,
      ts: now(),
      type: 'agent-end',
      role: 'drafter',
      model: usage?.model ?? row?.model ?? null,
      ...(usage
        ? { usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, toolUses: usage.toolUses, durationMs: usage.durationMs, totalTokens: usage.totalTokens, exact: usage.exact, outputEstimated: usage.outputEstimated } }
        : {}),
      metered: opts.metered,
      request,
      agentId: opts.agentId,
    });
    const { problems, draft } = draftProblems(readStaging(root, config, m.id), trackerRefCheck(root, config));
    if (!draft) throw new ForgeError(problems.slice(0, MAX_PROBLEMS).join('; '), 1);
    const stored: Draft = { schemaVersion: DRAFT_SCHEMA_VERSION, mandate: m.id, request, recordedAt: now(), ...draft };
    writeJsonAtomic(draftFile(root, m.id), stored, { root });
    logRepoEvent(root, 'mandate-draft', { mandate: m.id, request, issues: draft.issues.length, actor: currentActor(root) });
    try {
      fs.unlinkSync(path.join(draftsDir(root, config), `${m.id}.json`));
    } catch {}
    return {
      ok: true as const,
      mandate: m.id,
      request,
      draft: { issues: draft.issues.length, waves: Math.max(...draft.issues.map((i) => i.wave)), existing: draft.issues.filter((i) => i.existing !== null).length },
      spend: draftSpend(root, config, m.id),
      file: path.relative(root, draftFile(root, m.id)),
    };
  });
}

/** The drafting runs' spend, summed over the mandate's ledger: all zeros for none. */
export function draftSpend(root: string, config: Config, id: string): DraftSpend {
  const out: DraftSpend = { runs: 0, withUsage: 0, tokens: 0, usd: 0, metered: 0 };
  const text = readRegularText(ledgerFile(root, id), LEDGER_MAX_BYTES);
  if (text === null) return out;
  let usd = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (!isMap(e)) continue;
    out.runs++;
    if (e.metered === true) out.metered++;
    if (!hasUsage(e as { type: string; usage?: unknown })) continue;
    out.withUsage++;
    const u = e.usage as Record<string, unknown>;
    const n = (k: string): number => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
    out.tokens += n('totalTokens');
    usd += estimateCost(
      { model: typeof e.model === 'string' ? e.model : null, totalTokens: n('totalTokens'), input: n('input'), output: n('output'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite') },
      config.usage?.pricing,
    ).usd;
  }
  out.usd = Math.round(usd * 1e4) / 1e4;
  return out;
}

/** The note `draft show` gives while a request waits on an office session that isn't running. */
export const OFFICE_OFF_NOTE = 'the office session drafts it once daemon.enabled and foreman.enabled are on';

/** `forge mandate draft show`'s status, latest request, note, problem and draft for a goal mandate. */
export function draftStatus(
  root: string,
  config: Config,
  id: string,
): { status: DraftStatus; request: { id: string; status: string; result: string | null } | null; note: string | null; problem: string | null; draft: Draft | null } {
  const reqs = draftRequests(root, id);
  const latest = reqs.at(-1) ?? null;
  const read = readDraft(root, id);
  const draft = read !== null && !('problem' in read) ? read : null;
  let status: DraftStatus = 'none';
  if (reqs.some((r) => r.status === 'pending')) status = 'queued';
  else if (reqs.some((r) => r.status === 'in-progress')) status = 'drafting';
  else if (draft) status = 'ready';
  else if (read !== null) status = 'unreadable';
  else if (latest?.status === 'rejected') status = 'failed';
  const off = config.daemon?.enabled !== true || !foremanEnabled(config);
  return {
    status,
    request: latest ? { id: latest.id, status: latest.status, result: typeof latest.result === 'string' ? latest.result : null } : null,
    note: status === 'queued' && off ? OFFICE_OFF_NOTE : null,
    problem: read !== null && 'problem' in read ? read.problem : null,
    draft,
  };
}
