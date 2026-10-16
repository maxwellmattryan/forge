// Learnings carry an experiment and a review-by date, so the retro can check whether each one
// still moves its metric instead of letting stale lessons cost tokens on every run forever.
// Both files are edited by people and agents, so every parser here is linear and tolerant.
import path from 'node:path';
import { paths } from './paths.ts';
import type { ExperimentEntry, LearningEntry, Stats } from './types.ts';
import { readText } from './util.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METRIC_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** A real calendar date in `YYYY-MM-DD`; `2026-02-30` round-trips to March and is rejected. */
export function validDate(s: unknown): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Drops `<!-- … -->` comments with indexOf rather than a lazy regex, which goes quadratic on unclosed ones. */
function stripComments(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    if (close < 0) break; // no later comment can close either
    out += text.slice(at, open);
    at = close + 3;
  }
  return out + text.slice(at);
}

/** Top-level `- ` items, each with its indented continuation lines joined by spaces. */
function items(text: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of stripComments(text).split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      if (cur) out.push(cur.join(' '));
      cur = [line.slice(2).trim()];
    } else if (cur && /^[ \t]+\S/.test(line)) {
      cur.push(line.trim());
    } else if (cur) {
      out.push(cur.join(' '));
      cur = null;
    }
  }
  if (cur) out.push(cur.join(' '));
  return out;
}

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

export function parseExperiments(text: string): ExperimentEntry[] {
  return items(text).map((entry) => {
    const [first, ...rest] = entry.split(' · ');
    const e: ExperimentEntry = { id: null, date: validDate(first.trim()) ? first.trim() : null, change: '', metric: null, direction: null, baseline: null, status: null };
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
  });
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

export function verdict(direction: 'up' | 'down' | null, baseline: number | null, current: number | null | undefined): 'improved' | 'worse' | 'flat' | 'unknown' {
  if (!direction || baseline === null || current === null || current === undefined) return 'unknown';
  if (current === baseline) return 'flat';
  return (direction === 'up') === current > baseline ? 'improved' : 'worse';
}

/** Expiry includes today; both are `YYYY-MM-DD`, so string order is date order. */
export function expiredLearnings(learnings: LearningEntry[], today: string): LearningEntry[] {
  return learnings.filter((l) => l.reviewBy !== null && l.reviewBy <= today);
}

export function learningSummary(text: string): { count: number; oldestReviewBy: string | null } {
  const learnings = parseLearnings(text);
  let oldest: string | null = null;
  for (const l of learnings) if (l.reviewBy && (!oldest || l.reviewBy < oldest)) oldest = l.reviewBy;
  return { count: learnings.length, oldestReviewBy: oldest };
}

export const readLearnings = (root: string): LearningEntry[] => parseLearnings(readText(path.join(paths(root).notes, 'learnings.md')));
export const readExperiments = (root: string): ExperimentEntry[] => parseExperiments(readText(path.join(paths(root).notes, 'experiments.md')));
