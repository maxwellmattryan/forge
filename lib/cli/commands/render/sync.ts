// `forge sync` in human mode.
import { isMap } from '#core/shape.ts';
import { blocks, has, hang, list, paint, section, txt } from './kit.ts';
import type { Paint, Renderer } from './kit.ts';

function summary(r: Record<string, any>, integrating: string[], p: Paint): string {
  let s: string;
  if (r.error !== undefined) s = `${p.red('✗')} ${hang(String(r.error), txt(r.id).length + 4)}`;
  else if (has(r.retargeted, 'from', 'to')) s = `retargeted ${txt(r.retargeted.from)} → ${txt(r.retargeted.to)}`;
  else if (r.unblocked) s = 'unblocked';
  else if (r.umbrellaDone) s = 'all child jobs finished';
  else if (r.repoBudgetReleased) s = 'repo budget hold released';
  else if (r.pr) s = `#${txt(r.pr)} ${txt(r.state)}`;
  else s = '-';
  if (r.integrate || integrating.includes(r.id)) s += ' → integrate';
  if (r.reopen || r.reopened) s += ' reopened';
  return s;
}

export const sync: Renderer = (d, o) => {
  if (!has(d, 'synced', 'results', 'requests', 'integrating') || !Array.isArray(d.results)) return null;
  const p = paint(o.color);
  const integrating: string[] = Array.isArray(d.integrating) ? d.integrating.map(String) : [];
  const head = `synced ${txt(d.synced)} job(s) · ${txt(d.requests)} request(s) queued${integrating.length ? ` · integrating: ${list(integrating)}` : ''}`;
  const rows = d.results.filter(isMap).map((r: Record<string, any>) => `${txt(r.id)}  ${summary(r, integrating, p)}`);
  const ret = isMap(d.retention) ? d.retention : null;
  return blocks(
    head,
    section('Jobs', rows, p),
    ret && section('Retention', [Array.isArray(ret.archived) && ret.archived.length ? `archived: ${list(ret.archived)}` : null, Array.isArray(ret.logs) ? `logs pruned: ${ret.logs.length}` : null], p),
  );
};
