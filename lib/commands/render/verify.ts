// `forge verify` in human mode.
import { cell } from '../render.ts';
import { isMap } from '../../core/shape.ts';
import { blocks, duration, fields, has, line, marked, paint, section, short, txt, under } from './kit.ts';
import type { Paint, Renderer, Seg, Val } from './kit.ts';
import type { VerifyResult, VerifyStep } from '../../engine/workspace/worktree.ts';

function step(s: Omit<VerifyStep, 'tail'>, failure: VerifyStep | undefined, p: Paint): string {
  const name = txt(s.name);
  let head: string;
  if (s.skipped) head = marked('skip', [{ text: `${name}  skipped: ${txt(s.reason)}` }], p);
  else if (s.ok) head = marked(true, [{ text: name }, ...(typeof s.durationMs === 'number' ? [{ text: `  ${duration(s.durationMs)}` }] : [])], p);
  else head = marked(false, [{ text: `${name}  exit ${txt(s.exit)}` }], p);
  if (!failure || failure.name !== s.name || s.ok) return head;
  return [head, failure.tail?.trim() ? under(failure.tail, 2) : '', failure.log ? `  log ${txt(failure.log)}` : ''].filter(Boolean).join('\n');
}

/** A gate: its mark, then the rest of its object as the generic one-line JSON. */
function gate(v: unknown, p: Paint): Val {
  if (!isMap(v)) return null;
  const ok = 'ok' in v ? v.ok === true : !v.stopped;
  const { ok: _ok, ...rest } = v;
  const segs: Seg[] = [{ text: ok ? '✓' : '✗', style: ok ? p.green : p.red }];
  if (Object.keys(rest).length) segs.push({ text: ' ' }, cell(rest, p));
  return segs;
}

export const verify: Renderer = (d, o) => {
  if (!has(d, 'ok', 'round', 'attempt', 'sha', 'file', 'steps') || !Array.isArray(d.steps)) return null;
  const p = paint(o.color);
  const r = d as VerifyResult;
  const head = line([{ text: r.ok ? '✓' : '✗', style: r.ok ? p.green : p.red }, { text: ` verify ${r.ok ? 'passed' : 'failed'} · round ${txt(r.round)} attempt ${txt(r.attempt)} · ${short(r.sha, 7)}` }]);
  const steps = r.steps.map((s) => step(s, r.failure, p));
  // A failure that is not one of the listed steps (a gate verify added) still shows its tail.
  if (r.failure && !r.steps.some((s) => s.name === r.failure!.name && !s.ok)) steps.push(step({ ...r.failure, ok: false }, r.failure, p));
  const listed = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isMap).map((x: Record<string, any>) => [marked(x.ok === true, [{ text: txt(x.repo) }], p), x.failure ? under(String(x.failure), 2) : ''].filter(Boolean).join('\n')) : []);
  return blocks(
    head,
    section('Steps', steps, p),
    section('Gates', fields([['integrity', gate(r.integrity, p)], ['secrets', gate(r.secrets, p)], ['protected', gate(r.protected, p)], ['budget', gate(r.budget, p)]], p), p),
    section('Repos', listed(r.repos), p),
    section('Downstream', listed(r.downstream), p),
    `file ${txt(r.file)}`,
  );
};
