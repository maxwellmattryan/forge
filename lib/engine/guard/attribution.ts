// AI-attribution policy. Forge's default is that nothing it produces (commits, PR bodies,
// issues, comments, releases) credits an AI: the human who runs Forge is the author. Messages
// may still *mention* AI tools; only signatures, trailers and "generated with" footers are removed.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitEnv } from '#integrations/git/runner.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { readText } from '#core/os/fs.ts';

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

// The hook's view of a Bash command. Any mention of git, gh or glab counts, so global options before
// the subcommand (`git -c k=v commit`, `gh -R o/r pr create`) and a path to the binary hide nothing.
const PUBLISHING = /\b(git|gh|glab)\b/;
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s;&|]+)`;
// git's unambiguous abbreviations count (`--fil`, `--templ`), but only with `=` or a space right after
// the name, so `--filter=`, `--fixup=` and `--text` never do.
const LONG_FILE_FLAG = new RegExp(String.raw`(?:^|\s)--(?:fi(?:le?)?|body-file|notes-file|input|te(?:m(?:p(?:l(?:a(?:te?)?)?)?)?)?)(?:=|\s+)${VALUE}`, 'g');
// `-F msg`, `-Fmsg` and a cluster ending in the flag (`-aF msg`); `-t` is commit's --template.
const SHORT_FILE_FLAG = new RegExp(String.raw`(?:^|\s)-[A-Za-z]*?[Ft]\s*${VALUE}`, 'g');
// gh's and glab's fields (`-F key=@file`, `-f`, `--field`, `--raw-field`): only the `key=@path` form reads a file.
const FIELD_FLAG = new RegExp(String.raw`(?:^|\s)(?:-[Ff]\s*|--(?:raw-)?field(?:=|\s+))${VALUE}`, 'g');
const FIELD_VALUE = /^[^=\s]*=@([\s\S]+)$/;
const DIR_FLAG = new RegExp(String.raw`(?:^|\s)-C\s*${VALUE}`, 'g');
const MAX_MESSAGE_FILE = 1024 * 1024;
/** The hook's work stays bounded on any command: past these, nothing more is read. */
const MAX_DIR_BASES = 8;
const MAX_MESSAGE_FILES = 32;
// A quoted argument (`-m "Co-Authored-By: …"`), a `$'…\n…'` line or a JSON string starts mid-line,
// so text is scanned once more with quotes and literal `\n` as line breaks.
const LINE_BREAKS = /["']|\\n/;

const unquote = (v: string): string => v.replace(/^(["'])([\s\S]*)\1$/, '$2');

/** The path a flag's value names, or null: a field names only the part after `=@`, and `-` is stdin. */
function namedFile(raw: string, kind: 'long' | 'short' | 'field'): string | null {
  const v = unquote(raw);
  const field = kind === 'long' ? null : FIELD_VALUE.exec(v);
  const p = field ? unquote(field[1]) : kind === 'field' ? '' : v;
  return p && p !== '-' ? p : null;
}

/**
 * A message file's text, or null. Only an existing regular file under 1 MiB is read, and it is
 * opened non-blocking and checked again on the descriptor, so a FIFO or device an agent names (or
 * swaps in after the stat) never blocks the hook.
 */
function readMessageFile(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size >= MAX_MESSAGE_FILE) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const real = fs.fstatSync(fd);
      if (!real.isFile() || real.size >= MAX_MESSAGE_FILE) return null;
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The attribution lines a Bash command would publish: in the command itself and in every message
 * file it names (`--file`, `--body-file`, `--notes-file`, `--input`, `--template` and git's
 * unambiguous abbreviations `--fi`, `--fil`, `--te`…, with `=` or a space; `-F` or `-t`, attached,
 * spaced or ending a cluster; a `key=@path` field of `-F`, `-f`, `--field` or `--raw-field`). A
 * relative file is tried against `cwd` and against each of the first 8 `-C <dir>`, each resolved
 * against the one before, as git does; only the first 32 distinct files are read, so the cost is
 * bounded on any command. The command and each file are scanned as they are and once more split on
 * quotes and literal `\n`. `[]` when the command names no git, gh or glab. Commands built at run time
 * (`$(cat msg)`, `$F`, `cd dir &&`, `~`) are the documented residuals.
 */
export function commandAttribution(command: string, cwd: string): string[] {
  if (!PUBLISHING.test(command)) return [];
  const bases = new Set([cwd]);
  let base = cwd;
  let dirs = 0;
  for (const m of command.matchAll(DIR_FLAG)) {
    if (dirs++ === MAX_DIR_BASES) break;
    bases.add((base = path.resolve(base, unquote(m[1]))));
  }
  const named: { at: number; file: string | null }[] = [];
  for (const [re, kind] of [[LONG_FILE_FLAG, 'long'], [SHORT_FILE_FLAG, 'short'], [FIELD_FLAG, 'field']] as const)
    for (const m of command.matchAll(re)) named.push({ at: m.index, file: namedFile(m[1], kind) });
  const values = [...new Set(named.sort((a, b) => a.at - b.at).flatMap((n) => (n.file === null ? [] : [n.file])))].slice(0, MAX_MESSAGE_FILES);
  const files = new Set<string>();
  for (const p of values) for (const b of path.isAbsolute(p) ? [''] : bases) files.add(path.resolve(b, p));
  const texts = [command];
  for (const f of files) {
    const text = readMessageFile(f);
    if (text !== null) texts.push(text);
  }
  return [...new Set(texts.flatMap((t) => [...findAttribution(t), ...findAttribution(t.split(LINE_BREAKS).join('\n'))]))];
}

/**
 * Whether the project Claude Code runs in opted out with `aiAttribution: allow`, read only from the
 * main checkout of `projectDir`'s repository (`<common dir>/../.forge/config.yml`), never from a
 * worktree's own `.forge/`, the Bash cwd or FORGE_ROOT, all of which an agent can choose or write.
 * Every failure is false, so the lookup fails closed.
 */
export function repoAllowsAttribution(projectDir: string | undefined): boolean {
  if (!projectDir) return false;
  try {
    const r = git(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true, timeoutMs: 3000 });
    const common = r.ok ? r.stdout.trim() : '';
    if (!common || path.basename(common) !== '.git') return false;
    return /^aiAttribution:\s*["']?allow\b/m.test(readText(path.join(path.dirname(common), '.forge', 'config.yml')));
  } catch {
    return false;
  }
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
