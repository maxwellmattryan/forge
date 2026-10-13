// AI-attribution policy. Forge's default is that nothing it produces (commits, PR bodies,
// issues, comments, releases) credits an AI: the human who runs Forge is the author. Messages
// may still *mention* AI tools; only signatures, trailers and "generated with" footers are removed.
import { pathToFileURL } from 'node:url';
import type { Config } from './types.ts';
import { run } from './util.ts';

const AI = '(claude|anthropic|openai|chatgpt|gpt-?\\d|copilot|gemini|codex|cursor|devin|aider|windsurf|ai assistant|ai agent)';

/** Whole lines that are an AI signature or trailer. */
const LINE_PATTERNS = [
  new RegExp(`^\\s*co-authored-by:.*${AI}.*$`, 'i'),
  /^\s*co-authored-by:.*noreply@anthropic\.com.*$/i,
  /^\s*claude-session:.*$/i,
  new RegExp(`^.*\\b(generated|written|created|authored|made|built)\\s+(with|by|using)\\s+\\[?${AI}.*$`, 'i'),
  /^.*(claude\.com\/claude-code|claude\.ai\/code).*$/i,
  /^\s*🤖.*$/,
];

const isAttributionLine = (line: string): boolean => LINE_PATTERNS.some((re) => re.test(line));

export function findAttribution(text: string): string[] {
  return String(text ?? '')
    .split('\n')
    .filter(isAttributionLine)
    .map((l) => l.trim());
}

export function hasAttribution(text: string): boolean {
  return findAttribution(text).length > 0;
}

export function stripAttribution(text: string): string {
  const kept = String(text ?? '')
    .split('\n')
    .filter((l) => !isAttributionLine(l));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n') + (String(text ?? '').endsWith('\n') ? '\n' : '');
}

export function attributionForbidden(config: Config | null | undefined): boolean {
  if (process.env.FORGE_AI_ATTRIBUTION === 'allow') return false;
  return (config?.aiAttribution ?? 'forbid') !== 'allow';
}

/**
 * Rewrites unpushed-or-owned commits between base and HEAD whose messages carry AI attribution.
 * Uses a non-interactive rebase whose exec step amends each commit's message in place, so
 * authorship, dates and content are untouched.
 */
export function scrubBranch(cwd: string, base: string): { rewritten: number; commits: string[] } {
  const log = run('git', ['log', '--format=%H%x00%B%x1e', `${base}..HEAD`], { cwd, allowFail: true });
  if (!log.ok) return { rewritten: 0, commits: [] };
  const offending = log.stdout
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.split('\0'))
    .filter(([, body]) => hasAttribution(body))
    .map(([sha]) => sha.slice(0, 10));
  if (!offending.length) return { rewritten: 0, commits: [] };
  const self = new URL(import.meta.url).pathname;
  run('git', ['-c', 'sequence.editor=:', 'rebase', '--quiet', '--exec', `"${process.execPath}" "${self}" amend-head`, base], { cwd });
  return { rewritten: offending.length, commits: offending };
}

function amendHead(): void {
  const msg = run('git', ['log', '-1', '--format=%B']).stdout;
  const clean = stripAttribution(msg);
  if (clean.trim() && clean !== msg) run('git', ['commit', '--amend', '--no-verify', '--allow-empty', '-F', '-'], { input: clean });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'amend-head') amendHead();
