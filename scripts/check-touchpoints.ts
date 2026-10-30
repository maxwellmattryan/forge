// `npm run check:touchpoints [-- --base <ref>] [--head <ref>]`: the companion changes a diff is missing
// (a version step, a doc page), each named with its fix. RULES below is the table of touchpoint rules;
// the companions only a person can judge stay in docs/DEVELOPING.md › Where a change goes. Read-only and offline.
// The diff runs from the merge base with the base to the working tree plus untracked files, or to `--head`
// alone. Exit 0 when nothing is missing, 1 with findings, 2 on any error, so a broken run never reads as a
// pass (docs/CI.md). There is no skip: a rule that fires on a complete diff gets a narrower trigger here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiffLines, PINNED_DIFF_OPTS } from '../lib/engine/guard/integrity.ts';
import { globToRegExp } from '../lib/core/glob.ts';
import { gitEnv, historyEnv } from '../lib/integrations/git/runner.ts';
import { gitSync } from './git.ts';

/** One file of the diff. A deletion keeps its removed lines; an untracked file arrives as `A`, all added. */
export interface Change {
  path: string;
  /** The old path of a rename. */
  from?: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: string[];
  removed: string[];
}

export interface Finding {
  rule: string;
  files: string[];
  fix: string;
}

/** What made a rule fire: the files to name and, for the config rules, the keys. */
export interface Hit {
  files: string[];
  keys?: string[];
}

export interface Rule {
  id: string;
  fires(changes: readonly Change[]): Hit | null;
  satisfied(changes: readonly Change[], hit: Hit): boolean;
  fix(hit: Hit): string;
}

type Kind = 'code' | 'yaml';

const isLine = (l: string | null): l is string => l !== null;

/** Whether a change sits under the globs (by its new or old path) and outside `except`. */
function matcher(globs: readonly string[], except: readonly string[] = []): (c: Change) => boolean {
  const inc = globs.map(globToRegExp);
  const exc = except.map(globToRegExp);
  const ok = (p: string) => inc.some((re) => re.test(p)) && !exc.some((re) => re.test(p));
  return (c) => ok(c.path) || (c.from !== undefined && ok(c.from));
}

const CODE_NOISE = [/^[{}()[\];,]+$/, /^(?:\/\/|\/\*|\*)/, /^import\b/, /^\} from '/, /^export (?:type )?\* from\b/, /^export (?:type )?\{[^}]*\} from\b/];

/** A TypeScript line as net() compares it, or null when it carries no code: blank, punctuation, comment, import or re-export. */
export function normaliseCode(line: string): string | null {
  const l = line.trim().replace(/\s+/g, ' ').replace(/[;,]$/, '');
  return !l || CODE_NOISE.some((re) => re.test(l)) ? null : l;
}

/** A YAML line as net() compares it, or null for a blank or comment line; an action's pin is dropped so a bump cancels. */
export function normaliseYaml(line: string): string | null {
  const l = line.trim();
  if (!l || l.startsWith('#')) return null;
  // `\s#\s` and then trimEnd, not `\s+#\s`: a long run of spaces must not backtrack once per space.
  return l.replace(/\s#\s.*$/, '').trimEnd().replace(/^(-\s+)?uses:\s*([^@\s]+)@\S*$/, '$1uses: $2');
}

/**
 * Fires when the matching files, taken together, gain or lose a line that means something: moves
 * between them cancel, as do edits to comments, imports and re-exports (code) or pins (YAML).
 */
function net(globs: readonly string[], kind: Kind, except: readonly string[] = []): Rule['fires'] {
  const match = matcher(globs, except);
  const norm = kind === 'code' ? normaliseCode : normaliseYaml;
  return (changes) => {
    const counts = new Map<string, number>();
    const files: string[] = [];
    for (const c of changes) {
      if (!match(c)) continue;
      const added = c.added.map(norm).filter(isLine);
      const removed = c.removed.map(norm).filter(isLine);
      if (added.length || removed.length) files.push(c.path);
      for (const l of added) counts.set(l, (counts.get(l) ?? 0) + 1);
      for (const l of removed) counts.set(l, (counts.get(l) ?? 0) - 1);
    }
    return [...counts.values()].some((n) => n !== 0) ? { files } : null;
  };
}

/** Fires on any added or removed line in the matching files. */
function touched(globs: readonly string[]): Rule['fires'] {
  const match = matcher(globs);
  return (changes) => {
    const files = changes.filter((c) => match(c) && (c.added.length > 0 || c.removed.length > 0)).map((c) => c.path);
    return files.length ? { files } : null;
  };
}

const KEY_DOCS_FILE = 'lib/core/config/keys/docs.ts';
const KEY_RE = /^\s*(?:'([A-Za-z][\w.-]*)'|([A-Za-z_$][\w$]*))\s*:\s*\{/;

function keysIn(lines: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const l of lines) {
    const m = KEY_RE.exec(l);
    if (m) keys.add(m[1] ?? m[2]);
  }
  return keys;
}

/**
 * Fires when a key is added to KEY_DOCS (or removed, with `removed`; only undotted keys, with
 * `topLevel`). A changed value keeps its key on both sides, so it cancels. A new docs.ts is the
 * table's creation, not a key change, so it never fires.
 */
function configKeys(opts: { removed?: boolean; topLevel?: boolean } = {}): Rule['fires'] {
  return (changes) => {
    const docs = changes.filter((c) => c.path === KEY_DOCS_FILE && c.status !== 'A');
    const added = keysIn(docs.flatMap((c) => c.added));
    const removed = keysIn(docs.flatMap((c) => c.removed));
    let keys = [...added].filter((k) => !removed.has(k));
    if (opts.removed) keys.push(...[...removed].filter((k) => !added.has(k)));
    if (opts.topLevel) keys = keys.filter((k) => !k.includes('.'));
    return keys.length ? { files: [KEY_DOCS_FILE], keys: keys.sort() } : null;
  };
}

const DEPRECATIONS_FILE = 'lib/core/config/validators/deprecations.ts';

/**
 * Satisfied when every key is removed from KEY_DOCS (and not added back) and DEPRECATED_CONFIG_KEYS gains an
 * entry naming it, `{ key: '<key>', …`: a key nothing reads leaves with a doctor warning instead of a config step.
 */
function deprecatesAll(changes: readonly Change[], keys: readonly string[]): boolean {
  const docs = changes.filter((c) => c.path === KEY_DOCS_FILE && c.status !== 'A');
  const added = keysIn(docs.flatMap((c) => c.added));
  const removed = keysIn(docs.flatMap((c) => c.removed));
  return keys.length > 0 && keys.every((k) => removed.has(k) && !added.has(k) && addsLine(DEPRECATIONS_FILE, new RegExp(`\\bkey: '${escapeRe(k)}'`))(changes));
}

/** Satisfied when `file` gains a line matching `re`. */
function addsLine(file: string, re: RegExp): (changes: readonly Change[]) => boolean {
  return (changes) => changes.some((c) => c.path === file && c.added.some((l) => re.test(l)));
}

/** Satisfied when any matching file appears in the diff, under its old or new path, with any status. */
function changed(globs: readonly string[]): (changes: readonly Change[]) => boolean {
  const match = matcher(globs);
  return (changes) => changes.some(match);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
/** A version list entry: lib/core/versions/ and lib/api/versions.ts start each one on its own line like this. */
const STEP_LINE = /^ {2}\{ id: '/;
const keyList = (hit: Hit) => (hit.keys ?? []).join(', ');

/** The touchpoint rules, in the order findings print. */
export const RULES: readonly Rule[] = [
  {
    id: 'api-version',
    fires: net(['lib/api/*.ts'], 'code', ['lib/api/versions.ts', 'lib/api/tracker.ts', 'lib/api/*.test.ts']),
    satisfied: addsLine('lib/api/versions.ts', STEP_LINE),
    fix: () =>
      "append { id: '<kebab-id>' } to API_CHANGES in lib/api/versions.ts and set API_VERSION in dashboard/src/lib/core/types.ts to match (an extra step is harmless: the dashboard and server ship together)",
  },
  {
    id: 'config-step',
    fires: configKeys({ removed: true }),
    satisfied: (changes, hit) => addsLine('lib/core/versions/config.ts', STEP_LINE)(changes) || deprecatesAll(changes, hit.keys ?? []),
    fix: (hit) =>
      `config keys ${keyList(hit)} changed: append { id: '<kebab-id>', up: (c) => c } to CONFIG_STEPS in lib/core/versions/config.ts (a real up() when old configs change), with its row in test/schema.test.ts; or, for a key removed because nothing reads it, add it to DEPRECATED_CONFIG_KEYS in ${DEPRECATIONS_FILE}`,
  },
  {
    id: 'config-disclosure',
    fires: configKeys({ topLevel: true }),
    satisfied: (changes, hit) =>
      (hit.keys ?? []).every((k) => addsLine('lib/core/config/fields.ts', new RegExp(`^\\s*(?:'${escapeRe(k)}'|${escapeRe(k)})\\s*:\\s*'(?:plain|text|path|url|command)'`))(changes)),
    fix: (hit) =>
      `give ${keyList(hit)} a CONFIG_DISCLOSURE class in lib/core/config/fields.ts (plain, text, path, url or command), and decide which of its keys get FIELDS entries (editable only under the rule in its header)`,
  },
  {
    id: 'ci-docs',
    fires: net(['.github/workflows/ci.yml'], 'yaml'),
    satisfied: changed(['docs/CI.md']),
    fix: () => 'describe the workflow change in docs/CI.md',
  },
  {
    id: 'release-docs',
    fires: net(['.github/workflows/release.yml'], 'yaml'),
    satisfied: changed(['docs/RELEASES.md']),
    fix: () => 'describe the release pipeline change in docs/RELEASES.md',
  },
  {
    id: 'release-tests',
    fires: net(['scripts/release*.ts', 'scripts/stable-tree.ts'], 'code', ['**/*.test.ts']),
    satisfied: changed(['test/integration/scripts/**', 'test/invariants/release-workflow.test.ts']),
    fix: () => 'cover the change in test/integration/scripts/ (or the release workflow invariants)',
  },
  {
    id: 'pricing-asof',
    fires: touched(['lib/integrations/claude/pricing.json']),
    satisfied: addsLine('lib/integrations/claude/pricing.json', /^\s*"asOf":/),
    fix: () => `set "asOf" in lib/integrations/claude/pricing.json to the date you read Anthropic's current prices`,
  },
  {
    id: 'tracker-docs',
    fires: net(['lib/api/tracker.ts'], 'code'),
    satisfied: changed(['docs/TRACKERS.md']),
    fix: () => 'describe the contract change in docs/TRACKERS.md (lib/api/tracker.ts is a stable API for custom adapters)',
  },
];

/** The companions `changes` is missing, in rule order, each finding's files sorted. */
export function check(changes: readonly Change[], rules: readonly Rule[] = RULES): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    const hit = rule.fires(changes);
    if (!hit || rule.satisfied(changes, hit)) continue;
    out.push({ rule: rule.id, files: [...new Set(hit.files)].sort(), fix: rule.fix(hit) });
  }
  return out;
}

const STATUS: Record<string, Change['status']> = { A: 'A', C: 'A', D: 'D', M: 'M', R: 'R', T: 'M' };

const textLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/**
 * The change list from `diff --name-status -z` (records `X\0path\0`, or `R###\0old\0new\0`), the same
 * range's `-U0` diff, and the untracked files. A copy is an add of its new path; a type change is a modify.
 */
export function parseChanges(nameStatusZ: string, diff: string, untracked: readonly { path: string; text: string }[]): Change[] {
  const lines = parseDiffLines(diff);
  const parts = nameStatusZ.split('\0');
  const out: Change[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0];
    const two = letter === 'R' || letter === 'C';
    const first = parts[i++];
    const second = two ? parts[i++] : undefined;
    if (!first || (two && !second)) throw new Error(`truncated name-status record ${JSON.stringify(code)}`);
    const file = second ?? first;
    const fl = lines.get(file);
    const change: Change = { path: file, status: STATUS[letter] ?? 'M', added: fl ? fl.added.map((a) => a.text) : [], removed: fl ? [...fl.removed] : [] };
    if (letter === 'R') change.from = first;
    out.push(change);
  }
  for (const u of untracked) out.push({ path: u.path, status: 'A', added: textLines(u.text), removed: [] });
  return out;
}

/** Why a ref value from argv or env is refused, or null: it reaches git's argv, so no option, whitespace or control character. */
export function refProblem(value: string): string | null {
  if (value === '') return 'is empty';
  if (value.startsWith('-')) return 'starts with -';
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(value)) return 'holds whitespace or a control character';
  return null;
}

/** The base ref: `--base`, then FORGE_TOUCHPOINTS_BASE, then the first of origin/develop and develop that resolves. */
export function pickBase(opts: { base?: string; env: NodeJS.ProcessEnv; resolves: (ref: string) => boolean }): { ref: string } | { error: string } {
  const given: [string, string | undefined][] = [
    ['--base', opts.base],
    ['FORGE_TOUCHPOINTS_BASE', opts.env.FORGE_TOUCHPOINTS_BASE],
  ];
  for (const [from, value] of given) {
    if (value === undefined) continue;
    const bad = refProblem(value);
    if (bad) return { error: `${from} ${bad}` };
    return opts.resolves(value) ? { ref: value } : { error: `${from} ${JSON.stringify(value)} does not resolve to a commit` };
  }
  for (const ref of ['origin/develop', 'develop']) if (opts.resolves(ref)) return { ref };
  return { error: 'no base: neither origin/develop nor develop resolves to a commit; pass --base <ref>' };
}

const MAX_UNTRACKED = 1024 * 1024;

/** An untracked file's text, or '' unless it is a regular file of at most 1 MiB with no NUL byte; never follows a symlink. */
function readUntracked(file: string): string {
  try {
    if (!fs.lstatSync(file).isFile()) return '';
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_UNTRACKED) return '';
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, st.size, 0);
      const body = buf.subarray(0, n);
      return body.includes(0) ? '' : body.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

class Refusal extends Error {}

const oneLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();

function parseArgs(argv: readonly string[]): { base?: string; head?: string } {
  const out: { base?: string; head?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--base' && flag !== '--head') throw new Refusal(`unknown argument ${JSON.stringify(oneLine(flag))}; usage: check-touchpoints [--base <ref>] [--head <ref>]`);
    const key = flag === '--base' ? 'base' : 'head';
    if (out[key] !== undefined) throw new Refusal(`${flag} given twice`);
    if (i + 1 >= argv.length) throw new Refusal(`${flag} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

/** The check against the repo at `cwd`: the exit code and what goes to stdout and stderr. */
export function touchpoints(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { code: number; stdout: string; stderr: string } {
  // Replace objects and grafts are repo state a worktree can write; either can make HEAD look like the base.
  const gitEnvironment = { ...historyEnv(gitEnv(env)), GIT_OPTIONAL_LOCKS: '0' };
  let dir = cwd;
  const git = (args: string[], allow: number[] = [0]) => {
    const r = gitSync(args, { cwd: dir, env: gitEnvironment });
    if (r.error || r.status === null || !allow.includes(r.status)) throw new Error(`git ${args[0]} failed: ${oneLine(r.stderr ?? '') || r.error?.message || `exit ${r.status}`}`);
    return r;
  };
  try {
    const args = parseArgs(argv);
    if (args.head !== undefined) {
      const bad = refProblem(args.head);
      if (bad) throw new Refusal(`--head ${bad}`);
    }
    dir = git(['rev-parse', '--show-toplevel']).stdout.trim();
    const resolve = (ref: string): string | null => {
      const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], [0, 1]);
      const sha = r.stdout.trim();
      return r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    };
    const picked = pickBase({ base: args.base, env, resolves: (ref) => resolve(ref) !== null });
    if ('error' in picked) throw new Refusal(picked.error);
    const baseSha = resolve(picked.ref);
    const headRef = args.head ?? 'HEAD';
    const headSha = resolve(headRef);
    if (!baseSha) throw new Refusal(`${picked.ref} does not resolve to a commit`);
    if (!headSha) throw new Refusal(`${args.head === undefined ? 'HEAD' : '--head'} ${JSON.stringify(headRef)} does not resolve to a commit`);
    const mbRun = git(['merge-base', baseSha, headSha], [0, 1]);
    const mb = mbRun.stdout.trim();
    if (mbRun.status !== 0 || !/^[0-9a-f]{40,64}$/.test(mb)) throw new Refusal(`no merge base between ${picked.ref} and ${headRef}: fetch more history; CI checks out with fetch-depth: 2`);
    const range = args.head === undefined ? [mb] : [mb, headSha];
    const nameStatus = git(['diff', ...PINNED_DIFF_OPTS, '--name-status', '-z', ...range, '--']).stdout;
    const diff = git(['diff', ...PINNED_DIFF_OPTS, '-U0', '--text', ...range, '--']).stdout;
    const untracked =
      args.head === undefined
        ? git(['ls-files', '--others', '--exclude-standard', '-z'])
            .stdout.split('\0')
            .filter(Boolean)
            .map((rel) => ({ path: rel, text: readUntracked(path.join(dir, rel)) }))
        : [];
    const changes = parseChanges(nameStatus, diff, untracked);
    const findings = check(changes);
    const since = `since ${picked.ref} (${mb.slice(0, 7)})`;
    if (!findings.length) return { code: 0, stdout: `touchpoints: ok, ${changes.length} changed files ${since}\n`, stderr: '' };
    const body = findings.map((f) => `${f.rule}: ${f.files.join(', ')}\n  fix: ${f.fix}\n`).join('');
    return { code: 1, stdout: `touchpoints: ${findings.length} missing ${since}\n${body}`, stderr: '' };
  } catch (e) {
    return { code: 2, stdout: '', stderr: `touchpoints: ${oneLine((e as Error).message)}\n` };
  }
}

export function main(): void {
  const r = touchpoints(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
