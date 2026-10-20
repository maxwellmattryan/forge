// `forge pr open|sync|merge` in human mode.
import { cell } from '../render.ts';
import { blocks, fields, has, hang, isObj, line, marked, paint, section, table, txt } from './kit.ts';
import type { Paint, Renderer, Val } from './kit.ts';
import type { MergeResult } from '../../pr.ts';

export const prOpen: Renderer = (d, o) => {
  if (!has(d, 'number', 'url', 'created')) return null;
  const p = paint(o.color);
  let head = d.number === null ? 'no PR (pr.enabled is off or nothing to push)' : d.created ? `opened PR #${txt(d.number)} ${txt(d.url)}` : `PR #${txt(d.number)} already open ${txt(d.url)}`;
  if (d.unlinked) head += ' (unlinked)';
  const repos = Array.isArray(d.repos) ? d.repos.filter(isObj).map((r: Record<string, any>) => marked(r.number !== null && r.number !== undefined, [{ text: `${txt(r.repo)} #${txt(r.number)} ${txt(r.url)}` }], p)) : [];
  const deferred = Array.isArray(d.deferred) ? d.deferred.map((x: unknown) => line([cell(x, p)]).replace(/\n/g, ' ')) : [];
  return blocks(head, section('Repos', repos, p), section('Deferred', deferred, p));
};

export const prSync: Renderer = (d, o) => {
  if (!has(d, 'id', 'pr')) return null;
  if (d.pr === null) return `${txt(d.id)}: no PR`;
  if (!has(d.pr, 'number')) return null;
  const p = paint(o.color);
  const pr = d.pr;
  const out = [`#${txt(pr.number)} ${txt(pr.state)}`, ...fields([['checks', pr.checks?.state], ['behind', pr.behindBy], ['conflicts', pr.conflicts], ['threads', pr.unresolvedThreads], ['review', pr.reviewDecision], ['url', pr.url]], p)];
  if (d.integrate) out.push('→ moved to integrate');
  if (d.reopen) out.push('reopened');
  return out.join('\n');
};

function headline(r: MergeResult, p: Paint): string {
  // Later lines of the error start under its first, two columns for the mark plus the label.
  const err = (label: string): string => `${label}${hang(String(r.error ?? '-'), 2 + label.length)}`;
  switch (r.action) {
    case 'merged':
      return marked(true, [{ text: 'merged' }], p);
    case 'already-merged':
      return marked(true, [{ text: 'already merged' }], p);
    case 'auto':
      return 'auto-merge on: GitHub merges when checks pass';
    case 'deferred':
      return `deferred: checks ${txt(r.checks)}, merge state ${txt(r.mergeState)}`;
    case 'refused':
      return marked(false, [{ text: err('refused: ') + (r.reason ? ` (${txt(r.reason)})` : '') }], p);
    case 'failed':
      return marked(false, [{ text: err('failed: ') }], p);
  }
}

const ACTIONS = ['merged', 'already-merged', 'auto', 'deferred', 'refused', 'failed'];

export const prMerge: Renderer = (d, o) => {
  if (!has(d, 'action', 'merged') || !ACTIONS.includes(String(d.action))) return null;
  const p = paint(o.color);
  const r = d as MergeResult;
  const parts = Array.isArray(r.parts) && r.parts.length ? table(['repo', 'number', 'action', 'checks', 'error'], r.parts.map((x): Val[] => [txt(x.repo ?? null), x.number ? `#${txt(x.number)}` : '-', txt(x.action), txt(x.checks), txt(x.error)]), p) : null;
  return blocks(headline(r, p), section('Parts', [parts], p));
};
