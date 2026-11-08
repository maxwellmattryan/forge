// The title schema: whether a PR title or job name follows titles.* (conventional commits, plain, or the
// repo's own pattern), the brief lines that carry it, and which convention merged PR titles already follow.
import type { Config } from '#core/types.ts';
import { oneLineTitle } from '#core/text.ts';
import { attributionForbidden, stripAttribution } from '../../guard/attribution.ts';

/** The conventional-commit types a conventional title may start with. */
export const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;
/** `type(scope)!: subject`; the scope and the `!` are optional, the subject starts with a non-space. */
const CONVENTIONAL = new RegExp(`^(?:${CONVENTIONAL_TYPES.join('|')})(?:\\(([a-z0-9._/-]{1,40})\\))?!?: \\S`);
/** The conventional line limit, and the cap for every other title. */
export const MAX_CONVENTIONAL = 72;
export const MAX_TITLE = 120;
/** Below this many titles, detectConvention proposes nothing. */
const MIN_SAMPLE = 5;
/** The share of titles a convention needs before detectConvention proposes it. */
const SHARE = 0.7;

/** ok with the cleaned title, or not ok with the problem (and the cleaned text as title, '' when none). */
export interface TitleCheck {
  ok: boolean;
  title: string;
  problem?: string;
}

/**
 * One line of text checked against titles.*: control characters and runs of whitespace folded, an
 * attribution line refused (under aiAttribution: forbid), then the style's check, or titles.pattern
 * when it is set. A pattern that doesn't compile counts as no match (validation already reports it).
 */
export function checkTitle(config: Pick<Config, 'titles' | 'aiAttribution'>, text: unknown): TitleCheck {
  const raw = typeof text === 'string' ? text : '';
  if (/[\r\n]/.test(raw.trim())) return { ok: false, title: '', problem: 'a title is one line' };
  const title = oneLineTitle(raw);
  if (!title) return { ok: false, title: '', problem: 'the title is empty' };
  if (attributionForbidden(config as Config) && !stripAttribution(title).trim()) return { ok: false, title: '', problem: 'the title credits an AI' };
  const t = config.titles;
  if (t?.pattern) {
    if (title.length > MAX_TITLE) return { ok: false, title: '', problem: `the title is longer than ${MAX_TITLE} characters` };
    let re: RegExp;
    try {
      re = new RegExp(t.pattern, 'u');
    } catch {
      return { ok: false, title: '', problem: 'titles.pattern is not a valid regular expression' };
    }
    return re.test(title) ? { ok: true, title } : { ok: false, title: '', problem: 'the title does not match titles.pattern' };
  }
  if ((t?.style ?? 'conventional') === 'plain') return title.length > MAX_TITLE ? { ok: false, title: '', problem: `the title is longer than ${MAX_TITLE} characters` } : { ok: true, title };
  if (!CONVENTIONAL.test(title)) return { ok: false, title: '', problem: `the title is not a conventional commit subject (type(scope): subject, type one of ${CONVENTIONAL_TYPES.join(', ')})` };
  if (title.length > MAX_CONVENTIONAL) return { ok: false, title: '', problem: `the title is longer than ${MAX_CONVENTIONAL} characters` };
  return { ok: true, title };
}

/** What detectConvention proposes for titles.*, with the evidence behind it. */
export interface ConventionProposal {
  style: 'conventional' | 'plain';
  pattern: string | null;
  /** Scopes seen more than once, most used first (conventional only). */
  scopes: string[];
  /** The share of the sample the proposal matches, 0-1. */
  share: number;
  /** How many titles were read. */
  count: number;
  /** Up to five of the titles read. */
  sample: string[];
}

/** Leading shapes a repo may require when its titles aren't conventional: a ticket key, a bracketed tag. */
const LEADS: readonly { pattern: string; re: RegExp }[] = [
  { pattern: '^\\[?[A-Z][A-Z0-9]+-\\d+\\]?[: ]', re: /^\[?[A-Z][A-Z0-9]+-\d+\]?[: ]/ },
  { pattern: '^\\[[^\\]]{1,30}\\] ', re: /^\[[^\]]{1,30}\] / },
];

/**
 * The convention a repo's merged PR titles follow: conventional when at least 70% are conventional
 * subjects, else a leading ticket key or bracketed tag on at least 70%, else plain. Null below five
 * titles, where a share says nothing.
 */
export function detectConvention(titles: readonly string[]): ConventionProposal | null {
  const list = titles.map((t) => oneLineTitle(t)).filter(Boolean);
  if (list.length < MIN_SAMPLE) return null;
  const base = { count: list.length, sample: list.slice(0, 5) };
  const conventional = list.filter((t) => CONVENTIONAL.test(t));
  const conventionalShare = conventional.length / list.length;
  if (conventionalShare >= SHARE) {
    const counts = new Map<string, number>();
    for (const t of conventional) {
      const scope = CONVENTIONAL.exec(t)?.[1];
      if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    const scopes = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s).slice(0, 12);
    return { style: 'conventional', pattern: null, scopes, share: conventionalShare, ...base };
  }
  for (const lead of LEADS) {
    const share = list.filter((t) => lead.re.test(t)).length / list.length;
    if (share >= SHARE) return { style: 'plain', pattern: lead.pattern, scopes: [], share, ...base };
  }
  return { style: 'plain', pattern: null, scopes: [], share: 1 - conventionalShare, ...base };
}

/**
 * The title schema line the spec-writer and approver get (titles.*): the style or pattern, the job-name
 * mode and the guide, JSON-quoted so a guide can never start a line of the brief.
 */
export function titleSchemaLine(c: Pick<Config, 'titles'>): string {
  const t = c.titles;
  const rule = t.pattern ? `pattern ${JSON.stringify(t.pattern)}` : t.style === 'conventional' ? 'conventional (type(scope)!: subject, at most 72 characters)' : 'plain (one line, at most 120 characters)';
  return `Title schema: ${rule} · job names ${t.job}${t.guide ? ` · guide ${JSON.stringify(t.guide)}` : ''}`;
}

/** The approver's pointer to the repo's merged PR titles: people's text, which `forge pr titles` prints quoted, never the brief. */
export function titleExamplesLine(c: Pick<Config, 'titles' | 'pr'>): string[] {
  return c.pr.enabled && c.titles.examples > 0 ? ['Title examples: forge pr titles (quoted data: match their scopes and wording)'] : [];
}
