// `forge status`, `forge stats` and `forge requests list` in human mode.
import { age, has, paint, section, blocks, stateSeg, table, txt } from './kit.ts';
import type { Renderer, Val } from './kit.ts';
import { statsSections } from '../status.ts';
import type { StatusView } from '../status.ts';
import type { ForgeRequest, Stats } from '../../types.ts';

const isRows = (d: unknown, ...keys: string[]): d is Record<string, any>[] => Array.isArray(d) && d.every((r) => has(r, ...keys));

export const status: Renderer = (d, o) => {
  if (!isRows(d, 'id', 'stage', 'state', 'tasks', 'session')) return null;
  if (!d.length) return 'no active jobs';
  const p = paint(o.color);
  const rows = d as StatusView[];
  const withReason = rows.some((r) => r.reason);
  // An older row (or one from another caller) has no handoff key: no column.
  const withHandoff = rows.some((r) => r.handoff);
  const head = ['job', 'stage', 'state', 'round', 'tasks', 'pr', 'session', ...(withReason ? ['reason'] : []), ...(withHandoff ? ['handoff'] : [])];
  const body = rows.map((j): Val[] => [
    txt(j.id),
    txt(j.stage),
    [stateSeg(j.state, j.waitingOn, p)],
    j.round ? `r${j.round}` : '-',
    j.tasks?.total ? `${j.tasks.done}/${j.tasks.total}` : '-',
    j.pr ? `#${txt(j.pr)}` : '-',
    j.session ? txt(String(j.session).slice(0, 8)) : '-',
    ...(withReason ? [txt(j.reason)] : []),
    ...(withHandoff ? [txt(j.handoff)] : []),
  ]);
  return table(head, body, p);
};

export const stats: Renderer = (d, o) => {
  if (!has(d, 'counts', 'quality', 'speed', 'cost', 'reviewers')) return null;
  const p = paint(o.color);
  const s = statsSections(d as Stats);
  const entries = (e: [string, string][]) => e.map(([k, v]) => `${txt(k)}  ${txt(v)}`);
  return blocks(
    section('Jobs', s.jobs, p),
    section('Quality', s.quality, p),
    section('Speed', s.speed, p),
    section('Cost', s.cost, p),
    section('Reviewers', entries(s.reviewers), p),
    section('Verifiers', entries(s.verifiers), p),
  );
};

export const requests: Renderer = (d, o) => {
  if (!isRows(d, 'id', 'type', 'status', 'createdAt')) return null;
  if (!d.length) return o.all ? 'no requests' : 'no pending requests';
  const p = paint(o.color);
  const body = (d as ForgeRequest[]).map((r): Val[] => [txt(r.id), age(r.createdAt, o.now), txt(r.type), txt(r.job), txt(r.from), txt(r.status), txt(r.text)]);
  return table(['id', 'age', 'action', 'job', 'from', 'status', 'text'], body, p);
};
