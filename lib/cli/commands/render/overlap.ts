// `forge overlap` in human mode: the timing and its refs, why, one line per counterpart, idle, gaps and the report.
import { blocks, has, line, paint, section, table, txt } from './kit.ts';
import type { Renderer, Val } from './kit.ts';
import type { OverlapSummary } from '#engine/project/overlap.ts';

/** The fixed sentence for each reason code (docs/architecture/overlap.md). */
export const REASON_SENTENCES: Readonly<Record<string, string>> = {
  'no-overlap': 'No job, PR or push in the window touches these files.',
  'github-unread': 'GitHub could not be read, so outside PRs and pushes are unknown.',
  'outside-pr': 'An outside PR changes the same files.',
  'human-push': 'A person pushed changes to the same files in the window.',
  'job-ahead': 'A job further along changes the same files: let it merge first.',
  'job-behind': 'A ready job created later changes the same files: it can rebase on this one.',
  'job-early': 'A job that has not started building plans to change the same files: land this first.',
  'job-building': 'A job still building changes the same files: it can rebase on this one.',
};

export const overlap: Renderer = (d, o) => {
  if (!has(d, 'subject', 'timing', 'idle', 'reasons', 'counterparts', 'gaps', 'report') || !Array.isArray(d.counterparts) || !Array.isArray(d.reasons) || !Array.isArray(d.gaps)) return null;
  const p = paint(o.color);
  const s = d as OverlapSummary;
  const kind = txt(s.timing?.kind);
  const style = kind === 'merge-now' ? p.green : kind === 'needs-human' ? p.red : p.yellow;
  const refs = Array.isArray(s.timing?.refs) && s.timing.refs.length ? `: ${s.timing.refs.map(txt).join(', ')}` : '';
  const head = line([{ text: kind, style }, { text: `${refs} · ${txt(s.subject?.kind)} ${txt(s.subject?.ref)}` }]);
  const rows: Val[][] = s.counterparts.map((c) => [
    txt(c.kind),
    txt(c.ref),
    c.human ? 'person' : '',
    txt(c.stage),
    [c.files.map(txt).join(', '), c.fileCount > c.files.length ? ` +${c.fileCount - c.files.length}` : ''].join(''),
    c.source === 'file-map' ? 'from its file map' : `${txt(c.sharedHunks)} hunks`,
  ]);
  return blocks(
    head,
    section('Why', s.reasons.map((r) => REASON_SENTENCES[r] ?? txt(r)), p),
    rows.length ? section('Overlaps with', [table(['kind', 'ref', 'who', 'stage', 'files', 'lines'], rows, p)], p) : null,
    `idle ${s.idle === true ? 'yes' : 'no'}`,
    section('Gaps', s.gaps.map((g) => `${txt(g.code)}${g.ref ? ` ${txt(g.ref)}` : ''}`), p),
    `report ${txt(s.report)}`,
  );
};
