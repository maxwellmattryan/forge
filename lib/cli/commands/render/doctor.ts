// `forge doctor` in human mode: what is broken first, each with its fix under it.
import { blocks, has, line, marked, paint, section, txt, under } from './kit.ts';
import type { Paint, Renderer, Seg } from './kit.ts';
import type { DoctorCheck } from '../../../core/types.ts';

function count(n: number, word: string, style: (s: string) => string): Seg[] {
  return [{ text: String(n), style: n ? style : undefined }, { text: ` ${word}${n === 1 ? '' : 's'}` }];
}

const flagged = (c: DoctorCheck, kind: false | 'warn', p: Paint): string => [marked(kind, [{ text: txt(c.name) }], p), c.detail ? under(String(c.detail), 2) : ''].filter(Boolean).join('\n');

export const doctor: Renderer = (d, o) => {
  if (!has(d, 'ok', 'checks') || !Array.isArray(d.checks) || !d.checks.every((c: unknown) => has(c, 'name', 'ok'))) return null;
  const p = paint(o.color);
  const checks = d.checks as DoctorCheck[];
  const problems = checks.filter((c) => c.ok === false);
  const warnings = checks.filter((c) => c.ok !== false && c.warn);
  const ok = checks.filter((c) => c.ok !== false && !c.warn);
  const summary = line([...count(problems.length, 'problem', p.red), { text: ' · ' }, ...count(warnings.length, 'warning', p.yellow), { text: ' · ' }, { text: String(ok.length), style: ok.length ? p.green : undefined }, { text: ' ok' }]);
  return blocks(
    summary,
    section('Problems', problems.map((c) => flagged(c, false, p)), p),
    section('Warnings', warnings.map((c) => flagged(c, 'warn', p)), p),
    section('OK', ok.map((c) => marked(true, [{ text: txt(c.name) }, ...(c.detail ? [{ text: `  ${txt(c.detail)}` }] : [])], p)), p),
  );
};
