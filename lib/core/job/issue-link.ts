// A job's issue link: the pure half. Its only runtime import is the equally pure lib/core/job/issue-ref.ts,
// because lib/engine/pr/, lib/server/start.ts and the trackers import it; the
// operations that touch trackers and job state live in lib/engine/trackers/link.ts.
import { REF, linkedIssues } from './issue-ref.ts';
import type { Config, Job, TrackerItem } from '../types.ts';

export { REF };

/** Where a job stands on the issue rule; only `missing` asks a human for anything. */
export type IssueLinkStatus = 'no-tracker' | 'linked' | 'none' | 'exempt' | 'missing';

/** A tracker item with its search score, best first: scoreItems. */
export type ScoredItem = TrackerItem & { score: number };

export function issueLinkStatus(job: Pick<Job, 'issues' | 'noIssue' | 'kind' | 'parent'>, config: Pick<Config, 'tracker'>): IssueLinkStatus {
  if (config.tracker.kind === 'none') return 'no-tracker';
  if (linkedIssues(job).length) return 'linked';
  if (job.noIssue) return 'none';
  // Split children get the parent's sub-issue when they are created.
  if (job.kind === 'eval' || job.kind === 'retro' || job.parent) return 'exempt';
  return 'missing';
}

const STOPWORDS = new Set(
  'the and for with from into onto that this these those when then than should would could will can add fix make use using via per not are was were has have had our your their its job'.split(' '),
);

/** Lowercase words of 3+ alphanumerics from a title, minus stopwords, deduplicated, in order, at most 6. */
export function searchTerms(title: string): string[] {
  const words = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * Search terms from a free-text query: whitespace tokens carrying search syntax (a `:` qualifier,
 * quotes, parentheses, a leading `-`) are dropped first, then searchTerms keeps plain words only.
 */
export function queryTerms(query: string): string[] {
  const plain = String(query ?? '')
    .split(/\s+/)
    .filter((t) => t && !/[:()"\\]/.test(t) && !t.startsWith('-'));
  // `OR` is too short and `AND`/`NOT` are stopwords, so no boolean operator survives either.
  return searchTerms(plain.join(' '));
}

/**
 * Each distinct term in the title scores 2 and in the body 1; items scoring 0 are dropped, and ties
 * keep the tracker's order (Array.prototype.sort is stable).
 */
export function scoreItems<T extends TrackerItem>(items: T[], terms: string[]): (T & { score: number })[] {
  const distinct = [...new Set(terms.map((t) => t.toLowerCase()).filter(Boolean))];
  return items
    .map((item) => {
      const title = String(item.title ?? '').toLowerCase();
      const body = String(item.body ?? '').toLowerCase();
      let score = 0;
      for (const t of distinct) score += (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
      return { ...item, score };
    })
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** What `forge pr open` adds to its result: a nudge only while the job still lacks an issue. */
export function prLinkNote(job: Pick<Job, 'issues' | 'noIssue' | 'kind' | 'parent'>, config: Pick<Config, 'tracker'>): { unlinked?: true } {
  return issueLinkStatus(job, config) === 'missing' ? { unlinked: true } : {};
}
