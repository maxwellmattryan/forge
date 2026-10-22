// `forge job findings`: review findings raised per round and lens, the builder's answers to them
// (fixed or disputed), and findings that recur. Computed on demand from the review files and
// build.md; nothing is persisted, so it can never go stale.
import fs from 'node:fs';
import path from 'node:path';
import { HEADING, unfenced } from './acs.ts';
import { jobDir } from './jobs.ts';
import { lensFromReviewFile } from './lens.ts';
import type { SEVERITIES } from './schema.ts';

export type Severity = (typeof SEVERITIES)[number];

/** One tagged finding in a review file. */
export interface RaisedFinding {
  severity: Severity;
  path: string | null;
}

/** One builder answer line, attributed to the review round it answers. */
export interface FindingAnswer {
  round: number;
  lens: string;
  severity: Severity;
  path: string | null;
  outcome: 'fixed' | 'disputed';
}

interface Counts {
  raised: number;
  fixed: number;
  disputed: number;
}

/** CLI output of `forge job findings`, without the id. */
export interface JobFindings {
  rounds: (Counts & { round: number })[];
  /**
   * `severity`: the lens's raised findings by severity, present once it raised one. Archive records
   * written before it carry none, and stats leaves those out of its severity counts.
   */
  byLens: Record<string, Counts & { recurring: number; severity?: Record<Severity, number> }>;
  totals: Counts & { recurring: number };
  recurring: { lens: string; path: string; rounds: number[] }[];
  disputed: { round: number; lens: string; severity: Severity; path: string | null }[];
}

const LIST_CAP = 20;
const PATH_CAP = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const LENS = /^[a-z0-9][a-z0-9_-]*$/;
const ROUND_DIR = /^round-([1-9]\d*)$/;
// Every regex below runs over agent-written text, so each is linear: no two adjacent unbounded
// runs can match the same characters (see the comment on HEADING in lib/acs.ts).
// `s`: a Unicode line separator inside a finding must not hide it.
const REVIEW_LINE = /^\s*[-*]\s*\[(blocker|major|minor|nit)\](.*)$/is;
// The lens may be qualified (`lib:realtime`): the `:` ends the bounded repo run, so it stays linear.
const ANSWER_LINE = /^\s*[-*]\s+((?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}:)?[a-z0-9][a-z0-9_-]*)\s+\[?(blocker|major|minor|nit)\]?\s+(\S+)\s+(?:→|->)\s+(fixed\b|disagree:)/i;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

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
    out.push({ severity: m[1].toLowerCase() as Severity, path: first ? cleanPath(first) : null });
  }
  return out;
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

const zero = (): Counts => ({ raised: 0, fixed: 0, disputed: 0 });

/** All the counting, pure: `raised` maps each review round that has files to its lenses' findings. */
export function summariseFindings(raised: Map<number, { lens: string; severity: Severity; path: string | null }[]>, answers: FindingAnswer[]): JobFindings {
  const perRound = new Map<number, Counts>();
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
  const totals = { ...zero(), recurring: recurring.length };
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

/** Read-only. Integration reviews are excluded: only `review/round-<n>/<lens>.md` (or `<repo>.<lens>.md`) count. */
export function jobFindings(root: string, id: string): JobFindings {
  const dir = jobDir(root, id);
  const raised = new Map<number, { lens: string; severity: Severity; path: string | null }[]>();
  for (const d of entries(path.join(dir, 'review'))) {
    const m = ROUND_DIR.exec(d.name);
    if (!m || !d.isDirectory()) continue;
    const round = Number(m[1]);
    const findings: { lens: string; severity: Severity; path: string | null }[] = [];
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
  const build = readSmall(path.join(dir, 'build.md'));
  return summariseFindings(raised, build === null ? [] : parseAddressed(build));
}
