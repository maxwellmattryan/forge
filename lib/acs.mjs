// @ts-check
// `forge job acs`: which spec acceptance criteria the builder's latest AC table proves.
// Computed on demand from spec.md and build.md; nothing is persisted, so it can never go stale.
import path from 'node:path';
import { loadJob, jobDir } from './jobs.mjs';
import { exists } from './paths.mjs';
import { readText } from './util.mjs';

const FENCE = /^\s*(```|~~~)/;
// Linear on purpose: spec.md and build.md carry agent- and tracker-authored text, and a lazy group
// between optional runs (`(.*?)\s*#*\s*$`) backtracks cubically on a long run of spaces.
// Callers only match the start of the heading text, so closing `#`s needn't be stripped.
const HEADING = /^(#{1,6})\s+(.*)$/;
const SEPARATOR = /^\s*(?:\|\s*)?:?-{2,}/;
const ID = /^AC[- ]?(\d+)(?!\d)/i;
const NO_PROOF = new Set(['', '-', '—', 'none', 'n/a', 'tbd']);
const PASS = /^\s*(pass|passed|ok|yes|green|✓|✅)(?![a-z])/i;

/**
 * Lines outside code fences, with fence markers and fenced content blanked, so an example spec or
 * table quoted in a fence can't open or close a section.
 * @param {string} text @returns {(string|null)[]}
 */
function unfenced(text) {
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
 * @param {string} text @returns {string[]}
 */
export function specAcs(text) {
  const lines = unfenced(text);
  let level = 0;
  /** @type {(string|null)[]} */
  const items = [];
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

/** Cells of a table row: split on unescaped pipes, drop the empty edge cells. @param {string} line */
function cells(line) {
  const parts = line.split(/(?<!\\)\|/).map((c) => c.trim());
  if (parts.length && parts[0] === '') parts.shift();
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * The AC table of the latest round in build.md. Never falls back to an earlier round: proof has to
 * be current, so a round without a table maps nothing.
 * @param {string} text
 * @returns {{ round: number|null, table: boolean, rows: Record<string, {proof: string, result: string}>, order: string[] }}
 */
export function buildAcTable(text) {
  const lines = unfenced(text);
  let start = 0;
  /** @type {number|null} */
  let round = null;
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
      const h = lines[i] === null ? null : HEADING.exec(/** @type {string} */ (lines[i]));
      if (h && h[1].length <= 2) {
        end = i;
        break;
      }
    }
  }
  /** @type {string[][] | null} */
  let table = null;
  for (let i = start; i < end - 1; i++) {
    const line = lines[i];
    const sep = lines[i + 1];
    if (line === null || sep === null || !line.includes('|') || !SEPARATOR.test(sep)) continue;
    const header = cells(line);
    if (!/^ac$/i.test(header[0] ?? '')) continue;
    const body = [];
    let j = i + 2;
    for (; j < end && lines[j] !== null && /** @type {string} */ (lines[j]).includes('|'); j++) body.push(cells(/** @type {string} */ (lines[j])));
    table = [header, ...body];
    i = j - 1;
  }
  /** @type {Record<string, {proof: string, result: string}>} */
  const rows = {};
  /** @type {string[]} */
  const order = [];
  if (table) {
    const [header, ...body] = table;
    const find = (/** @type {RegExp} */ re, /** @type {number} */ fallback) => {
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
 * @param {string|null} specText @param {string|null} buildText
 */
export function acCoverage(specText, buildText) {
  const ids = specText === null ? [] : specAcs(specText);
  const t = buildText === null ? { round: null, table: false, rows: {}, order: [] } : buildAcTable(buildText);
  /** @type {string[]} */
  const unmapped = [];
  /** @type {string[]} */
  const failing = [];
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

/**
 * Read-only: no event, no job.json change, no file written.
 * @param {string} root @param {string} id
 */
export function jobAcs(root, id) {
  const job = loadJob(root, id);
  const dir = jobDir(root, job.id);
  const read = (/** @type {string} */ name) => (exists(path.join(dir, name)) ? readText(path.join(dir, name)) : null);
  return { id: job.id, ...acCoverage(read('spec.md'), read('build.md')) };
}
