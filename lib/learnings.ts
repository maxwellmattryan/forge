// Learnings carry an experiment and a review-by date, so the retro can check whether each one
// still moves its metric instead of letting stale lessons cost tokens on every run forever.
// Both files are edited by people and agents, so every parser here is linear and tolerant.
import path from 'node:path';
import { paths } from './paths.ts';
import { agentRoles } from './provenance.ts';
import type { ExperimentEntry, LearningEntry, Stats } from './types.ts';
import { readText } from './util.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const METRIC_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
export const FORBIDDEN: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A real calendar date in `YYYY-MM-DD`; `2026-02-30` round-trips to March and is rejected. */
export function validDate(s: unknown): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Drops `<!-- … -->` comments with indexOf rather than a lazy regex, which goes quadratic on unclosed
 * ones. `kept` lists the raw text's spans that survive, so an edit can find its way back to the raw file.
 */
function stripComments(text: string): { text: string; kept: { from: number; at: number; len: number }[] } {
  let out = '';
  let at = 0;
  const kept: { from: number; at: number; len: number }[] = [];
  const keep = (end: number) => {
    kept.push({ from: out.length, at, len: end - at });
    out += text.slice(at, end);
  };
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    if (close < 0) break; // no later comment can close either
    keep(open);
    at = close + 3;
  }
  keep(text.length);
  return { text: out, kept };
}

/** One top-level item: its lines joined, and each line's start in the comment-free text. */
interface Item {
  text: string;
  lines: { start: number; line: string }[];
}

/** Top-level `- ` items, each with its indented continuation lines joined by spaces. */
function itemWalk(stripped: string): Item[] {
  const out: Item[] = [];
  let cur: Item | null = null;
  const parts: string[] = [];
  const close = () => {
    if (cur) out.push({ ...cur, text: parts.join(' ') });
    cur = null;
    parts.length = 0;
  };
  let start = 0;
  for (const m of stripped.split(/(\r?\n)/)) {
    // The split keeps each separator, so `start` always points at the line's first character.
    if (m === '\n' || m === '\r\n') {
      start += m.length;
      continue;
    }
    const line = m;
    if (line.startsWith('- ')) {
      close();
      cur = { text: '', lines: [{ start, line }] };
      parts.push(line.slice(2).trim());
    } else if (cur && /^[ \t]+\S/.test(line)) {
      (cur as Item).lines.push({ start, line });
      parts.push(line.trim());
    } else close();
    start += line.length;
  }
  close();
  return out;
}

const items = (text: string): string[] => itemWalk(stripComments(text).text).map((i) => i.text);

/** Every top-level item's joined text: what the notes check compares between two versions. */
export const noteItems = items;

const dateAfter = (text: string, re: RegExp): string | null => {
  const m = re.exec(text);
  return m && validDate(m[1]) ? m[1] : null;
};

function ruleOf(entry: string): string {
  const open = entry.indexOf('**');
  const close = open < 0 ? -1 : entry.indexOf('**', open + 2);
  return close > open + 2 ? entry.slice(open + 2, close).trim() : entry;
}

export function parseLearnings(text: string): LearningEntry[] {
  return items(text).map((entry) => {
    const exp = /experiment:\s*([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/.exec(entry);
    return {
      rule: ruleOf(entry),
      experiment: exp ? exp[1] : null,
      reviewBy: dateAfter(entry, /review-by:\s*(\d{4}-\d{2}-\d{2})(?!\d)/),
      added: dateAfter(entry, /\badded\s+(\d{4}-\d{2}-\d{2})(?!\d)/),
    };
  });
}

/** A ledger item as `forge experiment` edits and checks it. */
export interface LedgerItem {
  entry: ExperimentEntry;
  /** The item's lines joined, as parseExperiments reads it. */
  text: string;
  /** Its first ` · ` segment that starts with `status `, or null. */
  statusSegment: string | null;
  /** Where that segment's `status open` sits in the raw text, when it is exactly that on one raw line; else null. */
  openAt: number | null;
}

const OPEN = 'status open';

/** The raw offset of a comment-free offset: inside one kept span, or -1. */
function rawOffset(kept: { from: number; at: number; len: number }[], i: number): number {
  for (const k of kept) if (i >= k.from && i < k.from + k.len) return k.at + (i - k.from);
  return -1;
}

/** Ledger items with their status segment and, for an open one, where an edit replaces it. */
export function ledgerItems(text: string): LedgerItem[] {
  const { text: stripped, kept } = stripComments(text);
  return itemWalk(stripped).map((item) => {
    // After the date, as parseExperiments reads keys.
    const statusSegment = item.text.split(' · ').slice(1).find((s) => s.startsWith('status ')) ?? null;
    let openAt: number | null = null;
    if (statusSegment === OPEN) {
      for (const { start, line } of item.lines) {
        let i = line.indexOf(OPEN);
        while (i >= 0 && openAt === null) {
          const before = line.slice(0, i);
          const after = line.slice(i + OPEN.length);
          if ((before.endsWith(' · ') || /^[ \t]*· $/.test(before)) && (after.trim() === '' || after.startsWith(' · '))) {
            const at = rawOffset(kept, start + i);
            // A comment between the words would make the raw text differ: never edited.
            if (at >= 0 && text.slice(at, at + OPEN.length) === OPEN) openAt = at;
          }
          i = line.indexOf(OPEN, i + 1);
        }
        if (openAt !== null) break;
      }
    }
    return { entry: parseExperiment(item.text), text: item.text, statusSegment, openAt };
  });
}

/** The denominator of a baseline that carries its sample, `0.344 (11/32)` or `0.318 (7/22; …)`. */
export function baselineN(value: string): number | null {
  const m = /^-?\d+(?:\.\d+)?\s*\((\d+)\/(\d+)[);]/.exec(value);
  return m ? Number(m[2]) : null;
}

export function parseExperiments(text: string): ExperimentEntry[] {
  return items(text).map(parseExperiment);
}

function parseExperiment(entry: string): ExperimentEntry {
  const [first, ...rest] = entry.split(' · ');
  const e: ExperimentEntry = { id: null, date: validDate(first.trim()) ? first.trim() : null, change: '', metric: null, direction: null, baseline: null, baselineN: null, status: null };
  const seen = new Set<string>();
  let change: string | null = null;
  for (const seg of rest) {
    const key = /^(id|metric|baseline|evidence|status) /.exec(seg)?.[1];
    if (!key) {
      change ??= seg.trim();
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = seg.slice(key.length + 1).trim();
    if (key === 'id') e.id = SLUG.test(value) ? value : null;
    else if (key === 'status') e.status = value.split(/\s/)[0] || null;
    else if (key === 'baseline') {
      const n = /^-?\d+(?:\.\d+)?/.exec(value);
      e.baseline = n ? Number(n[0]) : null;
      e.baselineN = baselineN(value);
    } else if (key === 'metric') {
      const paren = value.indexOf(' (');
      e.metric = (paren < 0 ? value : value.slice(0, paren)).trim() || null;
      if (paren >= 0) {
        const word = value.slice(paren + 2).split(/[\s;,)]/)[0];
        e.direction = word === 'up' || word === 'down' ? word : null;
      }
    }
  }
  e.change = change ?? '';
  return e;
}

/**
 * A ledger metric looked up in stats.json. `undefined` means unavailable: prose names, paths
 * through prototype keys or non-plain objects, and values that aren't a finite number or null.
 */
export function metricValue(stats: Stats, name: string): number | null | undefined {
  if (typeof name !== 'string' || name.length > 200 || !METRIC_PATH.test(name)) return undefined;
  let cur: unknown = stats;
  for (const seg of name.split('.')) {
    if (FORBIDDEN.has(seg)) return undefined;
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    const proto = Object.getPrototypeOf(cur);
    if (proto !== Object.prototype && proto !== null) return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null) return null;
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
}

/** Expiry includes today; both are `YYYY-MM-DD`, so string order is date order. */
export function expiredLearnings<T extends LearningEntry>(learnings: T[], today: string): T[] {
  return learnings.filter((l) => l.reviewBy !== null && l.reviewBy <= today);
}

/**
 * The notes files whose entries carry `experiment:` and `review-by:`: learnings.md, then each
 * role's addendum (`<role>.md` for an `agents/*.md` role), as paths under `.forge/`.
 */
export function noteFiles(): string[] {
  return ['notes/learnings.md', ...agentRoles().map((r) => `notes/${r}.md`)];
}

/** Every learning and addendum entry in the repo's notes, by file (`notes/<name>.md`). */
export function parseNoteEntries(root: string): { file: string; entries: LearningEntry[] }[] {
  const dir = paths(root).dir;
  return noteFiles().map((file) => ({ file, entries: parseLearnings(readText(path.join(dir, file))) }));
}

export function learningSummary(text: string): { count: number; oldestReviewBy: string | null } {
  const learnings = parseLearnings(text);
  let oldest: string | null = null;
  for (const l of learnings) if (l.reviewBy && (!oldest || l.reviewBy < oldest)) oldest = l.reviewBy;
  return { count: learnings.length, oldestReviewBy: oldest };
}

export const readLearnings = (root: string): LearningEntry[] => parseLearnings(readText(path.join(paths(root).notes, 'learnings.md')));
export const readExperiments = (root: string): ExperimentEntry[] => parseExperiments(readText(path.join(paths(root).notes, 'experiments.md')));
