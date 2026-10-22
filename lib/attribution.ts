// AI-attribution policy. Forge's default is that nothing it produces (commits, PR bodies,
// issues, comments, releases) credits an AI: the human who runs Forge is the author. Messages
// may still *mention* AI tools; only signatures, trailers and "generated with" footers are removed.
import { git, gitEnv } from './git.ts';
import type { Config } from './core/types.ts';
import { ForgeError } from './core/errors.ts';

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
 * Strips AI attribution from the messages of the commits between base and `head` without touching
 * the worktree: each commit is rewritten from its raw object with its own tree, author and committer,
 * so the content is exactly what the caller checked. The current branch moves to the rewritten tip
 * only if it still points at `head`, so a commit made meanwhile is never folded into the result.
 * Returns the sha to push. A rewritten commit loses its signature, which no longer matches.
 */
export function scrubBranch(cwd: string, base: string, head = 'HEAD', env: NodeJS.ProcessEnv = gitEnv()): { rewritten: number; commits: string[]; sha: string } {
  const tip = git(cwd, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`], { env }).stdout.trim();
  const list = git(cwd, ['rev-list', '--reverse', '--topo-order', '--parents', `${base}..${tip}`, '--'], { env, allowFail: true });
  if (!list.ok) return { rewritten: 0, commits: [], sha: tip };
  const map = new Map<string, string>();
  const offending: string[] = [];
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const [sha, ...parents] = line.split(' ');
    const raw = git(cwd, ['cat-file', 'commit', sha], { env }).stdout;
    const cut = raw.indexOf('\n\n');
    const headers = cut < 0 ? raw.replace(/\n$/, '') : raw.slice(0, cut);
    const msg = cut < 0 ? '' : raw.slice(cut + 2);
    const clean = stripAttribution(msg);
    if (hasAttribution(msg)) offending.push(sha.slice(0, 10));
    const reword = clean !== msg && Boolean(clean.trim());
    if (!reword && !parents.some((p) => map.has(p))) continue;
    const kept: string[] = [];
    let signature = false;
    for (const h of headers.split('\n')) {
      // Continuation lines belong to the header above them.
      if (h.startsWith(' ')) {
        if (!signature) kept.push(h);
        continue;
      }
      signature = /^gpgsig(-sha256)? /.test(h);
      if (signature) continue;
      kept.push(h.startsWith('parent ') ? `parent ${map.get(h.slice(7)) ?? h.slice(7)}` : h);
    }
    map.set(sha, git(cwd, ['hash-object', '-t', 'commit', '-w', '--stdin'], { env, input: `${kept.join('\n')}\n\n${reword ? clean : msg}`, write: true }).stdout.trim());
  }
  const sha = map.get(tip) ?? tip;
  if (sha === tip) return { rewritten: 0, commits: [], sha };
  const ref = git(cwd, ['symbolic-ref', '-q', 'HEAD'], { env, allowFail: true }).stdout.trim() || 'HEAD';
  const moved = git(cwd, ['update-ref', '-m', 'forge: strip AI attribution', ref, sha, tip], { env, allowFail: true, write: true });
  if (!moved.ok) throw new ForgeError(`${ref} moved off ${tip.slice(0, 12)} while its commit messages were scrubbed; nothing was pushed, run the command again`);
  return { rewritten: offending.length, commits: offending, sha };
}
