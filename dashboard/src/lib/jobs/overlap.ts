// The drawer's Overlaps with card: the job's last `forge overlap` report (GET /api/jobs/:id `overlap`) as rows.
// The report holds paths and refs a fork PR's author can choose, so every field is checked here and rendered as
// text; a PR links out only to an https url. No DOM access, so node:test can import it; OverlapSection.svelte renders it.
import type { OverlapKind, OverlapReport } from '../core/types.ts';
import { safeUrl } from '../text/markdown.ts';

/** How many shared files a row names before `+N`. */
export const OVERLAP_FILES_SHOWN = 3;

export interface OverlapRow {
  kind: OverlapKind;
  ref: string;
  /** What the ref opens: a job's drawer, a PR's https page, or nothing (a push, or a PR with no https url). */
  target: { drawer: string } | { href: string } | null;
  /** An outside PR or a person's push. */
  person: boolean;
  /** The first OVERLAP_FILES_SHOWN shared files. */
  files: string[];
  /** The shared files past those. */
  more: number;
  hunks: number;
  /** The counterpart was read from its spec's file map, so it has no line spans. */
  fileMap: boolean;
}

const KINDS: readonly string[] = ['job', 'pr', 'push'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const counterparts = (report: OverlapReport | null | undefined): unknown[] => (isRecord(report) && Array.isArray(report.counterparts) ? report.counterparts : []);

/** The card shows only for a report with at least one counterpart. */
export function showOverlap(report: OverlapReport | null | undefined): boolean {
  return overlapRows(report).length > 0;
}

/** One row per well-formed counterpart, in the report's order. */
export function overlapRows(report: OverlapReport | null | undefined): OverlapRow[] {
  const rows: OverlapRow[] = [];
  for (const c of counterparts(report)) {
    if (!isRecord(c) || typeof c.kind !== 'string' || !KINDS.includes(c.kind) || typeof c.ref !== 'string' || !c.ref) continue;
    const kind = c.kind as OverlapKind;
    const files = Array.isArray(c.files) ? c.files.filter((f): f is string => typeof f === 'string') : [];
    const url = typeof c.url === 'string' && c.url.startsWith('https://') ? safeUrl(c.url) : null;
    const target = kind === 'job' ? { drawer: c.ref } : kind === 'pr' && url ? { href: url } : null;
    rows.push({
      kind,
      ref: c.ref,
      target,
      person: c.human === true,
      files: files.slice(0, OVERLAP_FILES_SHOWN),
      more: Math.max(0, files.length - OVERLAP_FILES_SHOWN),
      hunks: Array.isArray(c.sharedHunks) ? c.sharedHunks.length : 0,
      fileMap: c.source === 'file-map',
    });
  }
  return rows;
}

/** The card's tone for a timing: merge-now ok, needs-human bad, wait-for and merge-first warn. */
export function timingTone(kind: unknown): 'ok' | 'bad' | 'warn' {
  return kind === 'merge-now' ? 'ok' : kind === 'needs-human' ? 'bad' : 'warn';
}
