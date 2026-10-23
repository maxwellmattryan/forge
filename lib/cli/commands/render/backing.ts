// `forge backing status` in human mode.
import { isMap } from '#core/shape.ts';
import { has, paint, table, txt } from './kit.ts';
import type { Paint, Renderer, Val } from './kit.ts';

function stateSeg(state: unknown, p: Paint): Val {
  const s = txt(state);
  if (state === 'running') return [{ text: s, style: p.green }];
  if (state === 'stopped' || state === 'missing') return [{ text: s, style: p.yellow }];
  if (state === 'unknown') return [{ text: s, style: p.red }];
  return s;
}

const portPairs = (v: unknown): string => (isMap(v) && Object.keys(v).length ? Object.entries(v).map(([c, h]) => `${txt(c)}→${txt(h)}`).join(', ') : '-');
const names = (v: unknown): string => (Array.isArray(v) && v.length ? v.map(txt).join(',') : '-');

export const backingStatus: Renderer = (d, o) => {
  const p = paint(o.color);
  if (has(d, 'job', 'services') && Array.isArray(d.services)) {
    if (!d.services.length) return `no backing services for ${txt(d.job)}`;
    const services = d.services.filter(isMap);
    // The database column only when some entry has a job database.
    const withDb = services.some((s: Record<string, any>) => isMap(s.database));
    const db = (v: unknown): Val[] => (!withDb ? [] : [isMap(v) && typeof v.name === 'string' ? txt(v.name) : '-']);
    const rows = services.map((s: Record<string, any>): Val[] => [txt(s.name), txt(s.isolation), stateSeg(s.state, p), txt(s.host), portPairs(s.ports), ...db(s.database), names(s.env)]);
    return table(['name', 'isolation', 'state', 'host', 'ports', ...(withDb ? ['database'] : []), 'env'], rows, p);
  }
  if (has(d, 'containers') && Array.isArray(d.containers)) {
    if (!d.containers.length) return 'no backing containers';
    const rows = d.containers.filter(isMap).map((c: Record<string, any>): Val[] => [txt(c.name), txt(c.job), txt(c.backing), stateSeg(c.state, p), c.orphan ? [{ text: 'orphan', style: p.yellow }] : '-']);
    return table(['name', 'job', 'backing', 'state', 'orphan'], rows, p);
  }
  return null;
};
