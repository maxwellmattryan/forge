// `forge job acs`: which spec acceptance criteria the builder's latest AC table proves.
// Computed on demand from spec.md and build.md; nothing is persisted, so it can never go stale.
import path from 'node:path';
import { loadJob, jobDir } from '../../core/job/store.ts';
import { exists } from '../../core/paths.ts';
import { readText } from '../../core/os/fs.ts';

const FENCE = /^\s*(```|~~~)/;
// Linear on purpose: spec.md and build.md carry agent- and tracker-authored text, and a lazy group
// between optional runs (`(.*?)\s*#*\s*$`) backtracks cubically on a long run of spaces.
// Callers only match the start of the heading text, so closing `#`s needn't be stripped.
export const HEADING = /^(#{1,6})\s+(.*)$/;
const SEPARATOR = /^\s*(?:\|\s*)?:?-{2,}/;
const ID = /^AC[- ]?(\d+)(?!\d)/i;
const NO_PROOF = new Set(['', '-', '—', 'none', 'n/a', 'tbd']);
const PASS = /^\s*(pass|passed|ok|yes|green|✓|✅)(?![a-z])/i;

/** The latest round's AC table in build.md: buildAcTable. */
export interface AcTable {
  round: number | null;
  table: boolean;
  rows: Record<string, { proof: string; result: string }>;
  order: string[];
}

/** How far the latest AC table covers the spec: acCoverage. */
export interface AcCoverage {
  total: number;
  covered: number;
  unmapped: string[];
  failing: string[];
  extra: string[];
  round: number | null;
  table: boolean;
  spec: boolean;
  build: boolean;
}

/**
 * Lines outside code fences, with fence markers and fenced content blanked, so an example spec or
 * table quoted in a fence can't open or close a section.
 */
export function unfenced(text: string): (string | null)[] {
  let fenced = false;
  return text.split(/\r?\n/).map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return null;
    }
    return fenced ? null : line;
  });
}

/**
 * AC ids from the first `Acceptance criteria…` section. Labelled items (`AC3`, `AC-3`, `**AC3**`)
 * win; a spec with no labels at all gets positional ids, so specs written before labels still work.
 */
export function specAcs(text: string): string[] {
  const lines = unfenced(text);
  let level = 0;
  const items: (string | null)[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === null) continue;
    const h = HEADING.exec(line);
    if (inside) {
      if (h && h[1].length <= level) break;
      const li = /^ {0,3}[-*+]\s+(?:\[[ xX]\]\s+)?(?:\*\*)?(.*)$/.exec(line);
      if (li) {
        const m = ID.exec(li[1]);
        items.push(m ? `AC${Number(m[1])}` : null);
      }
    } else if (h && /^acceptance criteria/i.test(h[2])) {
      level = h[1].length;
      inside = true;
    }
  }
  const labelled = items.filter((x) => x !== null);
  const ids = labelled.length ? labelled : items.map((_, i) => `AC${i + 1}`);
  return [...new Set(ids)];
}

/**
 * Labelled AC ids, in order, whose item in the first `Acceptance criteria…` section names a
 * screenshot proof. Reads the section exactly as specAcs does; the builder brief's `UI proof:` line.
 */
export function specUiAcs(text: string): string[] {
  const lines = unfenced(text);
  let level = 0;
  let inside = false;
  const ids: string[] = [];
  for (const line of lines) {
    if (line === null) continue;
    const h = HEADING.exec(line);
    if (inside) {
      if (h && h[1].length <= level) break;
      const li = /^ {0,3}[-*+]\s+(?:\[[ xX]\]\s+)?(?:\*\*)?(.*)$/.exec(line);
      const m = li ? ID.exec(li[1]) : null;
      if (m && /screenshots?\b/i.test(li![1])) ids.push(`AC${Number(m[1])}`);
    } else if (h && /^acceptance criteria/i.test(h[2])) {
      level = h[1].length;
      inside = true;
    }
  }
  return [...new Set(ids)];
}

/** Cells of a table row: split on unescaped pipes, drop the empty edge cells. */
function cells(line: string): string[] {
  const parts = line.split(/(?<!\\)\|/).map((c) => c.trim());
  if (parts.length && parts[0] === '') parts.shift();
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * The AC table of the latest round in build.md. Never falls back to an earlier round: proof has to
 * be current, so a round without a table maps nothing.
 */
export function buildAcTable(text: string): AcTable {
  const lines = unfenced(text);
  let start = 0;
  let round: number | null = null;
  lines.forEach((line, i) => {
    const h = line === null ? null : HEADING.exec(line);
    const r = h && h[1].length === 2 ? /^round\s+(\d+)\b/i.exec(h[2]) : null;
    if (r) {
      start = i + 1;
      round = Number(r[1]);
    }
  });
  let end = lines.length;
  if (round !== null) {
    for (let i = start; i < lines.length; i++) {
      const h = lines[i] === null ? null : HEADING.exec(lines[i] as string);
      if (h && h[1].length <= 2) {
        end = i;
        break;
      }
    }
  }
  let table: string[][] | null = null;
  for (let i = start; i < end - 1; i++) {
    const line = lines[i];
    const sep = lines[i + 1];
    if (line === null || sep === null || !line.includes('|') || !SEPARATOR.test(sep)) continue;
    const header = cells(line);
    if (!/^ac$/i.test(header[0] ?? '')) continue;
    const body: string[][] = [];
    let j = i + 2;
    for (; j < end && lines[j] !== null && (lines[j] as string).includes('|'); j++) body.push(cells(lines[j] as string));
    table = [header, ...body];
    i = j - 1;
  }
  const rows: Record<string, { proof: string; result: string }> = {};
  const order: string[] = [];
  if (table) {
    const [header, ...body] = table;
    const find = (re: RegExp, fallback: number) => {
      const i = header.findIndex((h, k) => k > 0 && re.test(h));
      return i > 0 ? i : fallback;
    };
    const proofCol = find(/proof|proven|test|command|evidence/i, 1);
    const resultCol = find(/result|status|outcome/i, 2);
    for (const row of body) {
      for (const m of (row[0] ?? '').matchAll(/AC[- ]?(\d+)(?!\d)/gi)) {
        const id = `AC${Number(m[1])}`;
        if (!(id in rows)) order.push(id);
        rows[id] = { proof: row[proofCol] ?? '', result: row[resultCol] ?? '' };
      }
    }
  }
  return { round, table: Boolean(table), rows, order };
}

/**
 * Coverage of the spec's ACs by the latest round's table. Pure; missing files are `null`.
 */
export function acCoverage(specText: string | null, buildText: string | null): AcCoverage {
  const ids = specText === null ? [] : specAcs(specText);
  const t: AcTable = buildText === null ? { round: null, table: false, rows: {}, order: [] } : buildAcTable(buildText);
  const unmapped: string[] = [];
  const failing: string[] = [];
  let covered = 0;
  for (const id of ids) {
    const row = t.rows[id];
    const proof = row ? row.proof.replace(/`/g, '').trim().toLowerCase() : '';
    if (!row || NO_PROOF.has(proof)) unmapped.push(id);
    else if (PASS.test(row.result)) covered += 1;
    else failing.push(id);
  }
  const extra = specText === null ? [] : t.order.filter((id) => !ids.includes(id));
  return { total: ids.length, covered, unmapped, failing, extra, round: t.round, table: t.table, spec: specText !== null, build: buildText !== null };
}

/** Read-only: no event, no job.json change, no file written. */
export function jobAcs(root: string, id: string): AcCoverage & { id: string } {
  const job = loadJob(root, id);
  const dir = jobDir(root, job.id);
  const read = (name: string) => (exists(path.join(dir, name)) ? readText(path.join(dir, name)) : null);
  return { id: job.id, ...acCoverage(read('spec.md'), read('build.md')) };
}
