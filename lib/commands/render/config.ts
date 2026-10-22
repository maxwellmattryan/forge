// `forge config show|get|validate` in human mode.
import { isMap } from '../../shape.ts';
import { blocks, has, hang, line, marked, paint, txt } from './kit.ts';
import type { Renderer } from './kit.ts';

const isScalar = (v: unknown): boolean => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
const isEmpty = (v: unknown): boolean => (Array.isArray(v) && !v.length) || (isMap(v) && !Object.keys(v).length);
/** Printed on its key's own line: scalars, empties and lists of scalars. */
const inline = (v: unknown): boolean => isScalar(v) || isEmpty(v) || (Array.isArray(v) && v.every(isScalar));

function value(v: unknown): string {
  if (v === null || v === undefined || isEmpty(v)) return '-';
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '-' : txt(x))).join(', ');
  return txt(v);
}

/** One object's keys: inline values aligned, nested objects and lists of objects two spaces deeper. */
function outline(o: Record<string, unknown>): string[] {
  const keys = Object.keys(o);
  const w = Math.max(0, ...keys.filter((k) => inline(o[k])).map((k) => txt(k).length));
  const out: string[] = [];
  for (const k of keys) {
    const v = o[k];
    const name = txt(k);
    if (inline(v)) out.push(line([{ text: name }, { text: ' '.repeat(w + 2 - name.length) }, { text: value(v) }]));
    else if (isMap(v)) out.push(name, ...outline(v).map((l) => `  ${l}`));
    else {
      out.push(name);
      for (const item of v as unknown[]) {
        const body = isMap(item) ? outline(item) : [value(item)];
        out.push(...body.map((l, i) => `${i ? '    ' : '  - '}${l}`));
      }
    }
  }
  return out;
}

const tree: Renderer = (d, o) => {
  if (!isMap(d)) return null;
  const p = paint(o.color);
  return blocks(
    ...Object.entries(d).map(([k, v]) => {
      if (inline(v)) return line([{ text: txt(k), style: p.bold }, { text: '  ' }, { text: value(v) }]);
      // A list of objects is outlined as if it were a key's value, without that key's line.
      const body = isMap(v) ? outline(v) : outline({ '': v }).slice(1).map((l) => l.slice(2));
      return [p.bold(txt(k)), ...body.map((l) => `  ${l}`)].join('\n');
    }),
  );
};

export const configShow = tree;
export const configGet = tree;

export const configValidate: Renderer = (d, o) => {
  if (!has(d, 'ok', 'initialized', 'problems') || !Array.isArray(d.problems)) return null;
  const p = paint(o.color);
  if (d.ok && d.initialized !== false && !d.problems.length) return marked(true, [{ text: 'config is valid' }], p);
  const n = d.problems.length;
  const out: string[] = [];
  if (d.initialized === false) out.push(marked(false, [{ text: 'not initialised: run /forge init' }], p));
  if (n || d.initialized !== false) out.push(marked(false, [{ text: `${n} ${n === 1 ? 'problem' : 'problems'}` }], p));
  for (const x of d.problems) out.push(`  - ${hang(String(x), 4)}`);
  return out.join('\n');
};
