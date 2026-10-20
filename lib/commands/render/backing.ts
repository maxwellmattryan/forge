// `forge backing status` in human mode.
import { has, isObj, paint, table, txt } from './kit.ts';
import type { Paint, Renderer, Val } from './kit.ts';

function stateSeg(state: unknown, p: Paint): Val {
  const s = txt(state);
  if (state === 'running') return [{ text: s, style: p.green }];
  if (state === 'stopped' || state === 'missing') return [{ text: s, style: p.yellow }];
  if (state === 'unknown') return [{ text: s, style: p.red }];
  return s;
}

const portPairs = (v: unknown): string => (isObj(v) && Object.keys(v).length ? Object.entries(v).map(([c, h]) => `${txt(c)}→${txt(h)}`).join(', ') : '-');
const names = (v: unknown): string => (Array.isArray(v) && v.length ? v.map(txt).join(',') : '-');

export const backingStatus: Renderer = (d, o) => {
  const p = paint(o.color);
  if (has(d, 'job', 'services') && Array.isArray(d.services)) {
    if (!d.services.length) return `no backing services for ${txt(d.job)}`;
    const rows = d.services.filter(isObj).map((s: Record<string, any>): Val[] => [txt(s.name), txt(s.isolation), stateSeg(s.state, p), txt(s.host), portPairs(s.ports), names(s.env)]);
    return table(['name', 'isolation', 'state', 'host', 'ports', 'env'], rows, p);
  }
  if (has(d, 'containers') && Array.isArray(d.containers)) {
    if (!d.containers.length) return 'no backing containers';
    const rows = d.containers.filter(isObj).map((c: Record<string, any>): Val[] => [txt(c.name), txt(c.job), txt(c.backing), stateSeg(c.state, p), c.orphan ? [{ text: 'orphan', style: p.yellow }] : '-']);
    return table(['name', 'job', 'backing', 'state', 'orphan'], rows, p);
  }
  return null;
};
