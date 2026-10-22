// `forge worktree create|remove` in human mode.
import { isMap } from '../../../core/shape.ts';
import { blocks, fields, has, list, marked, paint, ports, section, txt, under } from './kit.ts';
import type { Paint, Renderer } from './kit.ts';

/** `✓|✗ <label>`, with the untrusted text that explains a failure nested under it. */
const item = (ok: boolean, label: string, detail: unknown, p: Paint): string => [marked(ok, [{ text: label }], p), typeof detail === 'string' && detail.trim() ? under(detail, 2) : ''].filter(Boolean).join('\n');

const repos = (v: unknown, label: (r: Record<string, any>) => string, p: Paint): string | null =>
  section('Repos', Array.isArray(v) ? v.filter(isMap).map((r: Record<string, any>) => item(r.ok ?? !r.error, label(r), r.error, p)) : [], p);

export const worktreeCreate: Renderer = (d, o) => {
  if (!has(d, 'path', 'created', 'ports')) return null;
  const p = paint(o.color);
  const head = [`${d.created ? 'created' : 'exists'} ${txt(d.path)}`, ...fields([['base', d.base], ['stacked on', d.stackedOn], ['ports', ports(d.ports)]], p)].join('\n');
  const setup = Array.isArray(d.setup) ? d.setup.filter(isMap).map((s: Record<string, any>) => item(s.ok === true, txt(s.cmd), s.ok ? null : s.tail, p)) : [];
  const dbLabel = (b: Record<string, any>): string => (isMap(b.database) && typeof b.database.name === 'string' ? `  database ${txt(b.database.name)}` : '');
  const backing = Array.isArray(d.backing) ? d.backing.filter(isMap).map((b: Record<string, any>) => item(b.ok === true, `${txt(b.name)}  ${txt(b.action)}${dbLabel(b)}`, b.error, p)) : [];
  return blocks(head, section('Setup', setup, p), section('Backing', backing, p), repos(d.repos, (r) => `${txt(r.repo)}  ${txt(r.path)}`, p));
};

export const worktreeRemove: Renderer = (d, o) => {
  if (!has(d, 'removed')) return null;
  const p = paint(o.color);
  const rs = Array.isArray(d.repos) ? d.repos : [];
  const head = d.removed ? `removed ${txt(d.removed)}` : rs.length ? null : 'nothing to remove';
  const b = isMap(d.backing) ? d.backing : null;
  const backing = b
    ? [
        Array.isArray(b.removed) && b.removed.length ? `removed: ${list(b.removed)}` : null,
        Array.isArray(b.volumes) && b.volumes.length ? `volumes: ${list(b.volumes)}` : null,
        b.error ? item(false, txt(String(b.error).split('\n')[0]), String(b.error).split('\n').slice(1).join('\n'), p) : null,
      ]
    : [];
  return blocks(head, repos(rs, (r) => `${txt(r.repo)}  ${txt(r.removed)}`, p), section('Backing', backing, p));
};
