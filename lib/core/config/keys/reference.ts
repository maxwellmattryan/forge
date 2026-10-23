// docs/CONFIG.md's per-key reference: defaults() rendered as commented YAML from the doc strings in docs.ts, and the sync npm run docs:config writes.
// Only scripts/ and tests import this module: nothing at CLI start-up loads the doc strings.
import { defaults } from './defaults.ts';
import { KEY_DOCS } from './docs.ts';
import type { KeyDoc } from './docs.ts';
import { stringifyFlow, stringifyScalar } from '../../format/yaml.ts';
import { replaceRegion } from '../../format/region.ts';
import { getPath } from '../../shape.ts';

export const CONFIG_START = '<!-- forge:config:start (generated from lib/core/config/keys/ by npm run docs:config; edit the doc strings in docs.ts) -->';
export const CONFIG_END = '<!-- forge:config:end -->';

/** The column every key's comment starts at, so the defaults read as one aligned table. */
const COLUMN = 29;

type Docs = Readonly<Record<string, KeyDoc>>;

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalarList = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
const isMapList = (v: unknown[]): boolean => v.every(isMap);
const pathOf = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

/** A key's line with its doc string: the first line beside it at COLUMN, each later line under it. */
function withDoc(line: string, doc: string | undefined): string[] {
  if (!doc) return [line];
  const [first, ...rest] = doc.split('\n');
  const head = line.length <= COLUMN - 2 ? line.padEnd(COLUMN) : `${line}  `;
  return [`${head}# ${first}`, ...rest.map((t) => `${' '.repeat(COLUMN)}# ${t}`)];
}

function renderMap(map: Record<string, unknown>, prefix: string, indent: number, docs: Docs, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const key of Object.keys(map)) {
    const at = pathOf(prefix, key);
    const entry = docs[at];
    const value = map[key];
    const head = `${pad}${stringifyScalar(key)}:`;
    const children: string[] = [];
    let inline: string | null = null;
    if (isMap(value) && Object.keys(value).length) {
      if (entry?.layout === 'flow') inline = stringifyFlow(value);
      else renderMap(value, at, indent + 2, docs, children);
    } else if (Array.isArray(value) && value.length) {
      if (isMapList(value)) children.push(...value.map((item) => `${pad}  - ${stringifyFlow(item)}`));
      else if (entry?.layout === 'block' && isScalarList(value)) children.push(...value.map((item) => `${pad}  - ${stringifyScalar(item)}`));
      else inline = stringifyFlow(value);
    } else {
      inline = Array.isArray(value) ? '[]' : isMap(value) ? '{}' : stringifyScalar(value);
    }
    out.push(...withDoc(inline === null ? head : `${head} ${inline}`, entry?.doc), ...children);
    for (const line of entry?.more ?? []) out.push(`${pad}# ${line}`);
    if (!indent && key !== Object.keys(map).at(-1)) out.push('');
  }
}

/** `config` as commented YAML: every key in insertion order, its default and its doc string. Ends in a newline. */
export function renderConfigReference(config: object = defaults(), docs: Docs = KEY_DOCS): string {
  const out: string[] = [];
  renderMap(config as Record<string, unknown>, '', 0, docs, out);
  return `${out.join('\n')}\n`;
}

/** Everything wrong between `config` and `docs`, sorted: own-line keys with no doc, docs for missing keys, layouts that don't fit. */
export function configDocProblems(config: object, docs: Docs): string[] {
  const problems: string[] = [];
  const walk = (map: Record<string, unknown>, prefix: string) => {
    const uniform = docs[prefix]?.uniform === true;
    for (const [key, value] of Object.entries(map)) {
      const at = pathOf(prefix, key);
      if (!uniform && !docs[at]?.doc.trim()) problems.push(`${at}: no doc string in lib/core/config/keys/docs.ts`);
      if (isMap(value) && docs[at]?.layout !== 'flow') walk(value, at);
    }
  };
  walk(config as Record<string, unknown>, '');
  for (const [at, entry] of Object.entries(docs)) {
    const value = getPath(config, at);
    if (value === undefined) problems.push(`${at}: documented but not in defaults()`);
    else if ((entry.layout === 'flow' && !isMap(value)) || (entry.layout === 'block' && !isScalarList(value))) problems.push(`${at}: layout ${entry.layout} does not fit its value`);
  }
  return problems.sort();
}

/** docs/CONFIG.md's text with its reference block regenerated. */
export function syncConfigDoc(text: string): string {
  return replaceRegion(text, CONFIG_START, CONFIG_END, '```yaml\n' + renderConfigReference() + '```', 'docs/CONFIG.md');
}
