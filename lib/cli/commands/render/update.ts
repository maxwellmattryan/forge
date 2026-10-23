// `forge update` and `forge update --check` in human mode.
import { blocks, has, line, marked, paint, section, txt } from './kit.ts';
import type { Paint, Renderer } from './kit.ts';
import type { UpdateCheck, UpdateResult } from '#core/types.ts';

const warnings = (w: unknown, p: Paint): string | null => section('Warnings', Array.isArray(w) ? w.map((x) => marked('warn', [{ text: txt(x) }], p)) : [], p);

function result(r: UpdateResult, p: Paint): string {
  const head = r.updated
    ? `forge updated ${txt(r.from)} → ${txt(r.to)}${has(r.head, 'from', 'to') ? ` (${txt(r.head.from)} → ${txt(r.head.to)})` : ''}`
    : `forge is up to date (${txt(r.to)})`;
  const dash = r.dashboard;
  const dashLine = !dash ? null : 'restarted' in dash ? `restarted${dash.url ? ` ${txt(dash.url)}` : ''}` : `still serves the old version: ${txt(dash.url)}`;
  return blocks(
    head,
    r.newRoot ? `moved to ${txt(r.newRoot)}` : null,
    section('Ran', (r.commands ?? []).map(txt), p),
    section('Dashboard', [dashLine], p),
    warnings(r.warnings, p),
    section('Next', (r.next ?? []).map((n) => line([{ text: '- ' }, { text: txt(n) }])), p),
  );
}

function check(c: UpdateCheck, p: Paint): string {
  const head = [`forge ${txt(c.version)} (${txt(c.kind)} install at ${txt(c.root)})`];
  if (c.branch) head.push(`branch ${txt(c.branch)} tracking ${txt(c.upstream)}`);
  return blocks(
    head.join('\n'),
    section('Would run', c.commands.map(txt), p),
    section('Blocked', [c.blocked ? marked(false, [{ text: txt(c.blocked) }], p) : null], p),
    section('Dashboard', [c.dashboard ? `running ${txt(c.dashboard.url)}` : null], p),
    warnings(c.warnings, p),
  );
}

export const update: Renderer = (d, o) => {
  const p = paint(o.color);
  if (has(d, 'from', 'to', 'updated')) return result(d as UpdateResult, p);
  if (has(d, 'kind', 'version', 'commands') && Array.isArray(d.commands)) return check(d as UpdateCheck, p);
  return null;
};
