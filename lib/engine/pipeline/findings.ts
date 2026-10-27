// `forge job findings`: review findings raised per round and lens, the builder's answers to them
// (fixed or disputed), findings that recur, and the finding keys that group them across jobs.
// Computed on demand from the review files and build.md; nothing is persisted, so it can never go stale.
import fs from 'node:fs';
import path from 'node:path';
import { HEADING, unfenced } from './acs.ts';
import { jobDir } from '#core/job/store.ts';
import { lensFromReviewFile } from '#core/job/lens.ts';
import type { FindingCounts, JobFindings, Severity } from '#core/job/types.ts';

/** One tagged finding in a review file. */
export interface RaisedFinding {
  severity: Severity;
  path: string | null;
  /** The digits after the location token's first `:` (`lib/x.ts:42` → 42), else null. */
  line: number | null;
  /** The normalised title (findingTitle), the second half of the finding key; null when it has too few words. */
  title: string | null;
  /** The text after the severity tag, trimmed and capped at TEXT_CAP characters. Raw: callers sanitise it. */
  text: string;
}

/** A finding key (lens and title) raised in 2 or more distinct jobs. */
export interface RecurringGroup {
  lens: string;
  title: string;
  /** Every occurrence, across rounds and review files. */
  findings: number;
  /** Distinct job ids, sorted ascending. */
  jobs: string[];
  /** The first finding's text in input order, raw. */
  example: string;
}

/** One builder answer line, attributed to the review round it answers. */
export interface FindingAnswer {
  round: number;
  lens: string;
  severity: Severity;
  path: string | null;
  outcome: 'fixed' | 'disputed';
}

const LIST_CAP = 20;
const PATH_CAP = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const LENS = /^[a-z0-9][a-z0-9_-]*$/;
const ROUND_DIR = /^round-([1-9]\d*)$/;
// Every regex below runs over agent-written text, so each is linear: no two adjacent unbounded
// runs can match the same characters (see the comment on HEADING in lib/engine/pipeline/acs.ts).
// `s`: a Unicode line separator inside a finding must not hide it.
const REVIEW_LINE = /^\s*[-*]\s*\[(blocker|major|minor|nit)\](.*)$/is;
// The lens may be qualified (`lib:realtime`): the `:` ends the bounded repo run, so it stays linear.
const ANSWER_LINE = /^\s*[-*]\s+((?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}:)?[a-z0-9][a-z0-9_-]*)\s+\[?(blocker|major|minor|nit)\]?\s+(\S+)\s+(?:→|->)\s+(fixed\b|disagree:)/i;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const TEXT_CAP = 1000;
const TITLE_TOKENS = 64;
// How far after the location token a ` \u2014 ` separator may sit (`lib/x.ts:1 (and :5) \u2014 \u2026`).
const SEPARATOR_REACH = 8;
const SEPARATORS = new Set(['\u2014', '\u2013', '-', '--', ':']);
// Measured on this repo's 299 review findings over 68 jobs: 6 words grouped nothing across jobs,
// 4 grouped 3 real classes (the over-long header comment among them), and 3 added noise.
const TITLE_WORDS = 4;
const STOP_WORDS = new Set('a an and are as at be by for in is it its no not now of on or still that the this to with'.split(' '));

/**
 * The normalised title of a finding (`rest` is the text after its `[severity]` tag): its first
 * TITLE_WORDS words, lower-cased, without the location token, the text before a separator, code
 * spans, paths, punctuation and stop words. Null below 2 words, so a vague finding never groups.
 */
export function findingTitle(rest: string): string | null {
  let tokens = String(rest).slice(0, TEXT_CAP).trim().split(/\s+/).filter(Boolean).slice(0, TITLE_TOKENS);
  if (tokens.length && cleanPath(tokens[0]) !== null) tokens = tokens.slice(1);
  const sep = tokens.slice(0, SEPARATOR_REACH).findIndex((t) => SEPARATORS.has(t));
  if (sep >= 0) tokens = tokens.slice(sep + 1);
  const words = tokens
    .join(' ')
    .replace(/`[^`]{0,200}`/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !t.includes('/') && !/\.[a-z]/i.test(t))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, TITLE_WORDS);
  return words.length >= 2 ? words.join(' ') : null;
}

/**
 * The bare path of a location token (`lib/x.ts:42`, `` `README.md` ``, `docs/A.md:87,`), or null
 * when the token doesn't look like a path. Every path that leaves this module went through here.
 */
export function cleanPath(token: string): string | null {
  let p = String(token).replace(/[`*()]/g, '');
  const colon = p.indexOf(':');
  if (colon >= 0) p = p.slice(0, colon);
  // A loop, not /[.,;]+$/, which is quadratic on a long run of dots that doesn't end the token.
  let end = p.length;
  while (end > 0 && '.,;'.includes(p[end - 1])) end--;
  p = p.slice(0, end);
  if (p.startsWith('./')) p = p.slice(2);
  p = p.replace(UNSAFE, '').slice(0, PATH_CAP);
  return p && (p.includes('/') || p.includes('.')) ? p : null;
}

/** One entry per `- [severity] …` line outside code fences; the path is the first token's. */
export function parseReviewFindings(text: string): RaisedFinding[] {
  const out: RaisedFinding[] = [];
  for (const line of unfenced(text)) {
    if (line === null) continue;
    const m = REVIEW_LINE.exec(line);
    if (!m) continue;
    const first = m[2].trim().split(/\s+/)[0] ?? '';
    out.push({
      severity: m[1].toLowerCase() as Severity,
      path: first ? cleanPath(first) : null,
      line: first ? lineOf(first) : null,
      title: findingTitle(m[2]),
      text: m[2].trim().slice(0, TEXT_CAP),
    });
  }
  return out;
}

/** The line of a location token: the digits right after its first `:`, as cleanPath reads the path before it. */
function lineOf(token: string): number | null {
  const p = String(token).replace(/[`*()]/g, '');
  const colon = p.indexOf(':');
  const m = colon < 0 ? null : /^\d{1,9}/.exec(p.slice(colon + 1));
  return m ? Number(m[0]) : null;
}

/**
 * The builder's answer lines (`- <lens> <severity> <path:line|-> → fixed | disagree: …`) in each
 * `## Round <n>` section with n ≥ 2, attributed to review round n - 1. The dispute reason is never
 * captured, and identical answers within a round count once.
 */
export function parseAddressed(text: string): FindingAnswer[] {
  const out: FindingAnswer[] = [];
  const seen = new Set<string>();
  let round: number | null = null;
  for (const line of unfenced(text)) {
    if (line === null) continue;
    const h = HEADING.exec(line);
    if (h) {
      if (h[1].length <= 2) {
        const r = h[1].length === 2 ? /^round\s+(\d+)\b/i.exec(h[2]) : null;
        round = r ? Number(r[1]) : null;
      }
      continue;
    }
    if (round === null || round < 2) continue;
    const m = ANSWER_LINE.exec(line);
    if (!m) continue;
    const answer: FindingAnswer = {
      round: round - 1,
      lens: lensKey(m[1]),
      severity: m[2].toLowerCase() as Severity,
      path: m[3] === '-' ? null : cleanPath(m[3]),
      outcome: m[4].toLowerCase() === 'disagree:' ? 'disputed' : 'fixed',
    };
    const key = JSON.stringify([answer.round, answer.lens, answer.severity, answer.path, answer.outcome]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(answer);
  }
  return out;
}

/** An answer's lens as review files name it: a repo name keeps its case, the lens name is lowercased. */
function lensKey(raw: string): string {
  const colon = raw.lastIndexOf(':');
  return colon < 0 ? raw.toLowerCase() : `${raw.slice(0, colon)}:${raw.slice(colon + 1).toLowerCase()}`;
}

const zero = (): FindingCounts => ({ raised: 0, fixed: 0, disputed: 0 });

/** All the counting, pure: `raised` maps each review round that has files to its lenses' findings. */
export function summariseFindings(raised: Map<number, { lens: string; severity: Severity; path: string | null }[]>, answers: FindingAnswer[]): JobFindings {
  const perRound = new Map<number, FindingCounts>();
  const byLens: JobFindings['byLens'] = {};
  const lensOf = (lens: string) => (byLens[lens] ??= { ...zero(), recurring: 0 });
  const roundOf = (r: number) => {
    let c = perRound.get(r);
    if (!c) perRound.set(r, (c = zero()));
    return c;
  };
  // (lens, path) → the rounds it was raised in.
  const seenAt = new Map<string, { lens: string; path: string; rounds: Set<number> }>();
  for (const [r, findings] of raised) {
    const c = roundOf(r);
    for (const f of findings) {
      c.raised++;
      const l = lensOf(f.lens);
      l.raised++;
      (l.severity ??= { blocker: 0, major: 0, minor: 0, nit: 0 })[f.severity]++;
      if (f.path === null) continue;
      const key = JSON.stringify([f.lens, f.path]);
      let entry = seenAt.get(key);
      if (!entry) seenAt.set(key, (entry = { lens: f.lens, path: f.path, rounds: new Set() }));
      entry.rounds.add(r);
    }
  }
  const disputed: JobFindings['disputed'] = [];
  for (const a of answers) {
    const field = a.outcome === 'disputed' ? 'disputed' : 'fixed';
    roundOf(a.round)[field]++;
    lensOf(a.lens)[field]++;
    if (a.outcome === 'disputed') disputed.push({ round: a.round, lens: a.lens, severity: a.severity, path: a.path });
  }
  const recurring: JobFindings['recurring'] = [];
  for (const e of seenAt.values()) {
    const rounds = [...e.rounds].sort((a, b) => a - b);
    if (!rounds.some((r, i) => i > 0 && rounds[i - 1] === r - 1)) continue;
    recurring.push({ lens: e.lens, path: e.path, rounds });
    lensOf(e.lens).recurring++;
  }
  recurring.sort((a, b) => a.rounds[0] - b.rounds[0] || a.lens.localeCompare(b.lens) || a.path.localeCompare(b.path));
  disputed.sort((a, b) => a.round - b.round);
  const rounds = [...perRound.entries()].sort(([a], [b]) => a - b).map(([round, c]) => ({ round, ...c }));
  // Rounds 2+: a finding is carried when its (lens, path) was raised the round before (a round with no files raised nothing).
  let carried = 0;
  let fresh = 0;
  for (const [r, findings] of raised) {
    if (r < 2) continue;
    for (const f of findings) {
      if (f.path !== null && seenAt.get(JSON.stringify([f.lens, f.path]))!.rounds.has(r - 1)) carried++;
      else fresh++;
    }
  }
  const totals = { ...zero(), recurring: recurring.length, carried, new: fresh };
  for (const c of rounds) {
    totals.raised += c.raised;
    totals.fixed += c.fixed;
    totals.disputed += c.disputed;
  }
  return { rounds, byLens, totals, recurring: recurring.slice(0, LIST_CAP), disputed: disputed.slice(0, LIST_CAP) };
}

/**
 * A small regular file's text; null when it is absent or can't be read safely. The job dir is
 * agent-writable, so a link or a FIFO planted there is skipped rather than followed or waited on.
 */
function readSmall(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, st.size, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

export type LensFinding = RaisedFinding & { lens: string };

/**
 * A job's review findings by round (each round that has review files), in file-name then line order.
 * Read-only. Integration reviews are excluded: only `review/round-<n>/<lens>.md` (or `<repo>.<lens>.md`) count.
 */
export function raisedFindings(root: string, id: string): Map<number, LensFinding[]> {
  const dir = jobDir(root, id);
  const raised = new Map<number, LensFinding[]>();
  for (const d of entries(path.join(dir, 'review'))) {
    const m = ROUND_DIR.exec(d.name);
    if (!m || !d.isDirectory()) continue;
    const round = Number(m[1]);
    const findings: LensFinding[] = [];
    let files = 0;
    for (const f of entries(path.join(dir, 'review', d.name))) {
      const stem = f.name.endsWith('.md') ? f.name.slice(0, -3) : '';
      // `<repo>.<name>.md` is a member repo's qualified lens `<repo>:<name>`.
      const lens = stem.includes('.') ? lensFromReviewFile(f.name) : LENS.test(stem) ? stem : null;
      if (!f.isFile() || !lens) continue;
      const text = readSmall(path.join(dir, 'review', d.name, f.name));
      if (text === null) continue;
      files++;
      for (const x of parseReviewFindings(text)) findings.push({ lens, ...x });
    }
    if (files) raised.set(round, findings);
  }
  return raised;
}

/** Read-only: raisedFindings counted against the builder's answers in build.md. */
export function jobFindings(root: string, id: string): JobFindings {
  const build = readSmall(path.join(jobDir(root, id), 'build.md'));
  return summariseFindings(raisedFindings(root, id), build === null ? [] : parseAddressed(build));
}

/**
 * Pure: the finding keys (lens, title) raised in 2 or more distinct jobs, most jobs first, then most
 * findings, then lens and title. Findings with a null title never group. The caller caps the list.
 */
export function recurringAcrossJobs(perJob: { id: string; findings: LensFinding[] }[]): RecurringGroup[] {
  const groups = new Map<string, { lens: string; title: string; findings: number; jobs: Set<string>; example: string }>();
  for (const { id, findings } of perJob) {
    for (const f of findings) {
      if (f.title === null) continue;
      const key = JSON.stringify([f.lens, f.title]);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { lens: f.lens, title: f.title, findings: 0, jobs: new Set(), example: f.text }));
      g.findings++;
      g.jobs.add(id);
    }
  }
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...groups.values()]
    .filter((g) => g.jobs.size >= 2)
    .map((g) => ({ lens: g.lens, title: g.title, findings: g.findings, jobs: [...g.jobs].sort(byText), example: g.example }))
    .sort((a, b) => b.jobs.length - a.jobs.length || b.findings - a.findings || byText(a.lens, b.lens) || byText(a.title, b.title));
}
