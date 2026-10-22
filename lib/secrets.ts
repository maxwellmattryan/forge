// The secret scanner: Forge refuses to publish a likely credential. It runs wherever Forge sends
// something off the machine (verify's branch scan, `forge git commit`, `forge pr open`, tracker
// writes) and reports what agents write into the job dir. Findings never hold the value: the
// excerpt is masked and the fingerprint is its sha256 (a known value's is neither: see scanUnit).
// docs/CONFIG.md "Secret scanning".
// Must not import worktree.ts, pr.ts or commands/: worktree.ts and pr.ts import this module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PINNED_GIT_CONFIG } from './git-pins.ts';
import { inSpec } from './glob.ts';
import { PINNED_DIFF_OPTS, parseDiffLines } from './integrity.ts';
import { defaultAgentOutput, jobDir, logEvent } from './jobs.ts';
import { MIN_SECRET, knownValues } from './known-secrets.ts';
import { queueNotify } from './notify.ts';
import { realHistoryEnv, resolveBase } from './scope.ts';
import type { CompactSecrets, Config, Job, SecretAllowlist, SecretFinding, SecretKind, SecretScan, TextUnit } from './types.ts';
import { ForgeError, run } from './util.ts';

export const SECRET_KINDS = [
  'private-key',
  'aws-access-key',
  'github-token',
  'github-pat',
  'gitlab-token',
  'slack-token',
  'stripe-live-key',
  'anthropic-key',
  'openai-key',
  'google-api-key',
  'bearer-token',
  'url-credential',
  'high-entropy',
  // An exact occurrence of a job's known value (lib/known-secrets.ts): never a false positive.
  'known-secret',
] as const;

export type SecretMode = 'block' | 'warn';

/** The mode from the main checkout's config: anything but `warn` blocks, so a typo fails closed. */
export const secretMode = (config: Pick<Config, 'verifySecrets'>): SecretMode => (config.verifySecrets === 'warn' ? 'warn' : 'block');

/** Whether findings stop a gate under `mode`: any under `block`, a known value under either. */
export const secretsBlock = (findings: Pick<SecretFinding, 'kind'>[], mode: SecretMode): boolean => (mode === 'block' ? findings.length > 0 : findings.some((f) => f.kind === 'known-secret'));

const ALLOWLIST_FILE = '.forge/secrets-allow.txt';
const MAX_ALLOWLIST = 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_COMMITS = 1000;
const LIST_LIMIT = 10;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A finding before the allowlist: whether it came from repository content decides if path globs apply. */
type RawFinding = SecretFinding & { file: boolean };

interface Pattern {
  kind: SecretKind;
  re: RegExp;
  /** The capture group holding the value; the whole match otherwise. */
  group?: number;
  /** The value after its fixed prefix, which the placeholder check reads. */
  body?: (value: string) => string;
  /** Extra checks on the body; false drops the match. */
  accept?: (body: string) => boolean;
}

const after = (n: number) => (v: string) => v.slice(n);

// Every regex is linear on hostile input: no two adjacent quantifiers can match the same characters,
// and each unbounded run ends on a character its own class excludes. `d` gives group offsets.
const PATTERNS: Pattern[] = [
  { kind: 'private-key', re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----([\s\S]*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/dg },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/dg, body: after(4) },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/dg, body: after(4) },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,244}\b/dg, body: after(11) },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,64}(?![A-Za-z0-9_-])/dg, body: after(6) },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,250}(?![A-Za-z0-9-])/dg, body: after(5) },
  { kind: 'stripe-live-key', re: /\b[rs]k_live_[A-Za-z0-9]{20,247}\b/dg, body: after(8) },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{32,250}(?![A-Za-z0-9_-])/dg, body: after(7) },
  {
    kind: 'openai-key',
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,250}(?![A-Za-z0-9_-])/dg,
    body: (v) => v.replace(/^sk-(?:proj-|svcacct-|admin-)?/, ''),
    accept: (b) => /[0-9]/.test(b),
  },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/dg, body: after(4) },
  { kind: 'bearer-token', re: /\bauthorization\b["']?\s*[:=]\s*["']?bearer\s+([A-Za-z0-9._~+/-]{20,1024}=*)/dgi, group: 1 },
  { kind: 'url-credential', re: /[?&;](?:password|passwd|pwd|pass|token|access_token|auth_token|api_key|apikey|secret|client_secret)=([^&#\s"'<>\x60]{8,512})/dgi, group: 1 },
  { kind: 'url-credential', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/?#@"'<>\x60]{1,128}:([^\s/?#@"'<>\x60]{6,256})@/dgi, group: 1 },
];

const QUOTED = /(["'\x60])([A-Za-z0-9+/_=-]{33,256})\1/dg;
// The name may not follow a base64 character, or `+x=…` inside a long blob would read as an assignment.
const ASSIGNED = /(?:^|[^A-Za-z0-9_.$+/=-])([A-Za-z_][A-Za-z0-9_.-]{0,63})[ \t]*=[ \t]*([A-Za-z0-9][A-Za-z0-9+/_=-]{32,255})(?![A-Za-z0-9+/_=-])/dgm;
const SECRET_WORDS = /secret|token|passw|pwd|api[_-]?key|private[_-]?key|credential|auth[_-]?(?:key|token)|access[_-]?key|signing[_-]?key/i;
const PLACEHOLDER_WORDS = ['example', 'placeholder', 'dummy', 'redacted', 'changeme', 'xxxx', '****', 'your_', 'your-'];
const STOCK_WORDS = new Set(['password', 'passwd', 'secret', 'token', 'null', 'undefined', 'none', 'true', 'false']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'flake.lock', 'uv.lock']);
const MINIFIED = ['.min.js', '.min.css', '.map', '.svg'];

/** A value that is clearly not a real credential: a reference, a template, or a stand-in. */
export function isPlaceholder(body: string): boolean {
  // `{user}`, `{password}` and `{database}` are Forge's url placeholders (backing `database`), filled per job at run time.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(body) || /^<[^<>]*>$/.test(body) || /^\{\{[^{}]*\}\}$/.test(body) || /^\{(?:user|password|database)\}$/.test(body)) return true;
  if (new Set(body).size < 5) return true;
  const lower = body.toLowerCase();
  return PLACEHOLDER_WORDS.some((w) => lower.includes(w)) || STOCK_WORDS.has(lower);
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Where only provider patterns run: lockfiles, minified and generated output, and binary content. */
export function entropyOff(file: string, config: Pick<Config, 'worktrees'> | null, text = ''): boolean {
  const base = path.posix.basename(file);
  if (LOCKFILES.has(base) || MINIFIED.some((s) => base.endsWith(s))) return true;
  const generated = config?.worktrees?.generated;
  if (Array.isArray(generated) && generated.length && inSpec(file, generated.map(String))) return true;
  return text.includes('\0');
}

/** A shown character that could break a table, a code span or a line becomes `?`. */
const shown = (s: string): string => s.replace(/[`|\s\x00-\x1f\x7f\u2028\u2029]/g, '?');

/** The masked form of a value: first 4 and last 2 characters of 16+, first 2 of 8–15, nothing of less. */
export function mask(value: string): string {
  const chars = [...value];
  if (chars.length >= 16) return `${shown(chars.slice(0, 4).join(''))}…${shown(chars.slice(-2).join(''))}`;
  if (chars.length >= 8) return `${shown(chars.slice(0, 2).join(''))}…`;
  return '…';
}

/** `sha256:` + the sha256 hex of the value's UTF-8 bytes. Not secret: it can appear in output and events. */
export function fingerprint(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** The base64 body of a PEM key: header lines, literal \n/\r escapes and whitespace removed. */
function pemBody(raw: string): string {
  return raw
    .replace(/\\[nr]/g, '\n')
    .split(/\r?\n|\r/)
    .filter((l) => !l.includes(':'))
    .join('')
    .replace(/\s+/g, '');
}

const lineAt = (unit: TextUnit, offset: number): number => {
  let n = unit.line;
  for (let i = unit.text.indexOf('\n'); i >= 0 && i < offset; i = unit.text.indexOf('\n', i + 1)) n++;
  return n;
};

const lineText = (text: string, offset: number): string => {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end < 0 ? text.length : end);
};

/** One match before it becomes a finding: where it sits in the unit's text and what it holds. */
interface Span {
  kind: SecretKind;
  value: string;
  start: number;
  end: number;
  lineOffset: number;
}

/**
 * Every match in one unit. Spans already claimed by an earlier kind are skipped, so `sk-ant-` is
 * only ever `anthropic-key` and a provider match is never also `high-entropy`.
 */
function findSpans(unit: TextUnit, config: Pick<Config, 'worktrees'> | null, known: readonly string[] = []): Span[] {
  const out: Span[] = [];
  const overlaps = (s: number, e: number) => out.some((t) => s < t.end && t.start < e);
  const add = (kind: SecretKind, value: string, start: number, end: number, lineOffset: number) => {
    out.push({ kind, value, start, end, lineOffset });
  };
  // First, so a known value is reported as what it is rather than as a provider pattern.
  for (const v of known) {
    if (v.length < MIN_SECRET) continue;
    for (let at = unit.text.indexOf(v); at >= 0; at = unit.text.indexOf(v, at + v.length)) if (!overlaps(at, at + v.length)) add('known-secret', v, at, at + v.length, at);
  }
  for (const p of PATTERNS) {
    for (const m of unit.text.matchAll(p.re)) {
      const idx = m.indices!;
      if (p.kind === 'private-key') {
        const value = pemBody(m[3] ?? '');
        const [s, e] = idx[0]!;
        if ((value.match(/[A-Za-z0-9+/=]/g) ?? []).length < 64 || isPlaceholder(value) || overlaps(s, e)) continue;
        add(p.kind, value, s, e, s);
        continue;
      }
      const g = p.group ?? 0;
      const value = m[g];
      const span = idx[g];
      if (value === undefined || !span) continue;
      const body = p.body ? p.body(value) : value;
      if (isPlaceholder(body) || (p.accept && !p.accept(body)) || overlaps(span[0], span[1])) continue;
      add(p.kind, value, span[0], span[1], span[0]);
    }
  }
  const checkEntropy = unit.entropy ?? unit.file;
  if (!checkEntropy || entropyOff(unit.path, config, unit.text)) return out;
  for (const [re, group] of [[QUOTED, 2], [ASSIGNED, 2]] as const) {
    for (const m of unit.text.matchAll(re)) {
      const value = m[group];
      const span = m.indices![group];
      if (!span || overlaps(span[0], span[1]) || !highEntropy(value, lineText(unit.text, span[0]))) continue;
      add('high-entropy', value, span[0], span[1], span[0]);
    }
  }
  return out;
}

// A known value may be an 8-character dev password, so its plain sha256 or prefix could be brute-
// forced from an event or a report. Its id is keyed by this process's random key: it only dedupes.
const KNOWN_KEY = crypto.randomBytes(32);
const KNOWN_EXCERPT = '<known>';
const knownPrint = (value: string): string => `known:${crypto.createHmac('sha256', KNOWN_KEY).update(value, 'utf8').digest('hex').slice(0, 12)}`;

/** Findings in one unit: the spans, masked and fingerprinted; a known value shows nothing of itself. */
function scanUnit(unit: TextUnit, config: Pick<Config, 'worktrees'> | null, known: readonly string[]): RawFinding[] {
  return findSpans(unit, config, known).map((s) => ({
    kind: s.kind,
    path: unit.path,
    line: lineAt(unit, s.lineOffset),
    excerpt: s.kind === 'known-secret' ? KNOWN_EXCERPT : mask(s.value),
    fingerprint: s.kind === 'known-secret' ? knownPrint(s.value) : fingerprint(s.value),
    commit: unit.commit,
    file: unit.file,
  }));
}

/**
 * Where the scanner finds a likely credential in free text, provider patterns and the entropy check
 * both on and no allowlist: the support bundle replaces these spans, it never decides to keep one.
 */
export function secretSpans(text: string, config: Pick<Config, 'worktrees'> | null): { kind: SecretKind; start: number; end: number }[] {
  return findSpans({ ...textUnit('(bundle)', text), entropy: true }, config).map(({ kind, start, end }) => ({ kind, start, end }));
}

/** The entropy rule for one candidate value on its line. */
function highEntropy(value: string, line: string): boolean {
  if (value.length < 33 || value.length > 256) return false;
  if (isPlaceholder(value) || /^sha(?:1|256|384|512)-/.test(value) || !/[A-Za-z0-9]/.test(value)) return false;
  if (/^[0-9a-f]+$/.test(value) || /^[0-9A-F]+$/.test(value)) return entropy(value) >= 3.0 && SECRET_WORDS.test(line);
  return entropy(value) >= 4.3 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Every finding in the units, the same (path, fingerprint) reported once, at its first unit. `known`
 * (a job's known values) adds a `known-secret` finding for each exact occurrence.
 */
export function scanUnits(units: TextUnit[], opts: { config: Pick<Config, 'worktrees'> | null; known?: readonly string[] }): RawFinding[] {
  const seen = new Set<string>();
  const out: RawFinding[] = [];
  for (const u of units) {
    for (const f of scanUnit(u, opts.config, opts.known ?? [])) {
      const key = `${f.path}\0${f.fingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/**
 * Units from a `-U0` diff: each run of consecutive added lines of one file, so a multi-line PEM key
 * is one unit. A file whose added lines hold a NUL byte keeps only the provider patterns.
 */
export function diffUnits(raw: string, commit: string | null): { units: TextUnit[]; files: string[] } {
  const units: TextUnit[] = [];
  const files: string[] = [];
  for (const [file, { added }] of parseDiffLines(raw)) {
    files.push(file);
    const binary = added.some((a) => a.text.includes('\0'));
    let run: { line: number; lines: string[] } | null = null;
    const flush = () => {
      if (run) units.push({ path: file, line: run.line, text: run.lines.join('\n'), file: true, commit, ...(binary ? { entropy: false } : {}) });
      run = null;
    };
    for (const a of added) {
      if (run && run.line + run.lines.length === a.line) run.lines.push(a.text);
      else {
        flush();
        run = { line: a.line, lines: [a.text] };
      }
    }
    flush();
  }
  return { units, files };
}

// ---------- allowlist ----------

/**
 * Reads exactly one regular file through one descriptor that never follows a symlink. Returns null
 * when it is missing; throws a one-line reason for anything else that is not a readable regular file.
 */
function readRegular(file: string, max: number, inside?: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(code === 'ELOOP' || code === 'EMLINK' ? 'is a symlink' : `is unreadable (${code})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('is not a regular file');
    if (st.size > max) throw new Error(`is larger than ${max / 1024 / 1024} MiB`);
    if (inside) {
      const real = fs.realpathSync(file);
      const rel = path.relative(inside, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('resolves outside its directory');
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Parses the allowlist text: blanks, `#` comments, path globs and `sha256:<64 hex>` lines. */
export function parseAllowlist(text: string): Pick<SecretAllowlist, 'entries' | 'problems' | 'globs' | 'prints'> {
  const globs: { glob: string; line: number }[] = [];
  const prints = new Map<string, number>();
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    if (t.startsWith('!')) return void problems.push(`${ALLOWLIST_FILE}:${line}: negated entries are not supported; the line is ignored`);
    if (/^sha256:/i.test(t)) {
      if (/^sha256:[0-9a-f]{64}$/.test(t)) {
        if (!prints.has(t)) prints.set(t, line);
      } else problems.push(`${ALLOWLIST_FILE}:${line}: a fingerprint is sha256: and 64 lower-case hex characters; the line is ignored`);
      return;
    }
    globs.push({ glob: t, line });
  });
  return { entries: globs.length + prints.size, problems, globs, prints };
}

/** `.forge/secrets-allow.txt` of the checkout at `root`, which is always the main checkout. */
export function loadAllowlist(root: string): SecretAllowlist {
  const empty = { globs: [], prints: new Map<string, number>() };
  let text: string | null;
  try {
    text = readRegular(path.join(root, ALLOWLIST_FILE), MAX_ALLOWLIST);
  } catch (e) {
    return { file: ALLOWLIST_FILE, present: true, entries: 0, problems: [`${ALLOWLIST_FILE} ${(e as Error).message}, so it allows nothing`], ...empty };
  }
  if (text === null) return { file: ALLOWLIST_FILE, present: false, entries: 0, problems: [], ...empty };
  return { file: ALLOWLIST_FILE, present: true, ...parseAllowlist(text) };
}

/**
 * Splits findings into reported and allowed. A fingerprint allows a finding anywhere; a path glob
 * only one in repository content, never in text Forge sends or in the job dir.
 */
export function applyAllowlist(findings: RawFinding[], allow: SecretAllowlist): { findings: SecretFinding[]; allowed: SecretFinding[] } {
  const out: SecretFinding[] = [];
  const allowed: SecretFinding[] = [];
  for (const { file, ...f } of findings) {
    // A declared secret is never a false positive, so nothing allows one.
    if (f.kind === 'known-secret') {
      out.push(f);
      continue;
    }
    const byPrint = allow.prints.get(f.fingerprint);
    const byGlob = file ? allow.globs.find((g) => inSpec(f.path, [g.glob]))?.line : undefined;
    const line = byPrint ?? byGlob;
    if (line === undefined) out.push(f);
    else allowed.push({ ...f, allowedBy: `${ALLOWLIST_FILE}:${line}` });
  }
  return { findings: out, allowed };
}

function emptyScan(allow: SecretAllowlist): SecretScan {
  return { findings: [], allowed: [], scanned: { commits: 0, files: 0, texts: 0, skipped: 0 }, allowlist: allow, base: null, mergeBase: null };
}

/** Text Forge composes and sends, as units: the entropy check is off and only fingerprints allow. */
export const textUnit = (label: string, text: string): TextUnit => ({ path: label, line: 1, text, file: false, commit: null });

// ---------- scans ----------

// Repo config can re-encode log output (i18n.logOutputEncoding UTF-16 interleaves NULs, which the
// message parse splits on) or add signature text, so the message scan pins both.
const LOG_PINS: readonly string[] = ['-c', 'i18n.logOutputEncoding=UTF-8'];

/**
 * What a job's branch would publish, against `merge-base(base, HEAD)` as integrity computes it:
 * every non-merge commit on its own (a key added then deleted still counts), every merge commit's
 * own changes (`--remerge-diff`: its conflict resolution and anything else it added beyond git's
 * automatic merge, which a later commit may have removed again), the net diff (what a merge brought
 * in), every commit message, and with `staged` the index. Never throws for git
 * trouble: the problem goes into `error`, and an unfinished scan never reads as clean. `head` (a
 * commit id) binds the scan to the commit the caller records as checked; HEAD otherwise.
 */
export function scanBranch(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'base'>, opts: { staged: boolean; head?: string }): SecretScan {
  const allow = loadAllowlist(root);
  const scan = emptyScan(allow);
  const raw: RawFinding[] = [];
  try {
    if (!job.worktree) throw new ForgeError(`job ${job.id} has no worktree`);
    const cwd = job.worktree;
    const env = realHistoryEnv();
    const git = (args: string[]) => run('git', args, { cwd, env }).stdout;
    const head = opts.head ?? 'HEAD';
    if (head !== 'HEAD' && !SHA.test(head)) throw new ForgeError(`${JSON.stringify(head.slice(0, 80))} is not a commit id`);
    const { baseRef, mergeBase } = resolveBase(cwd, config, job, head);
    scan.base = baseRef;
    scan.mergeBase = mergeBase;
    if (!SHA.test(mergeBase)) throw new ForgeError(`merge-base ${JSON.stringify(mergeBase.slice(0, 80))} is not a commit id`);
    const range = `${mergeBase}..${head}`;
    const shas = git(['rev-list', '--reverse', '--no-merges', range, '--']).split('\n').filter(Boolean);
    const merges = git(['rev-list', '--reverse', '--merges', range, '--']).split('\n').filter(Boolean);
    if (shas.length + merges.length > MAX_COMMITS) throw new ForgeError(`the branch has ${shas.length + merges.length} commits since its base; the scanner reads at most ${MAX_COMMITS}`);
    const units: TextUnit[] = [];
    const files = new Set<string>();
    const addDiff = (out: string, commit: string | null) => {
      const d = diffUnits(out, commit);
      units.push(...d.units);
      for (const f of d.files) files.add(f);
    };
    for (const sha of shas) {
      if (!SHA.test(sha)) throw new ForgeError(`git rev-list printed ${JSON.stringify(sha.slice(0, 80))}, not a commit id`);
      addDiff(git([...PINNED_GIT_CONFIG, 'show', '--no-show-signature', '--format=', ...PINNED_DIFF_OPTS, '--text', '-U0', sha, '--']), sha.slice(0, 12));
    }
    // A merge's resolution lands in no ordinary commit; `--remerge-diff` (git ≥ 2.36) shows it
    // against git's own automatic merge, so base-side content isn't rescanned as the job's.
    for (const sha of merges) {
      if (!SHA.test(sha)) throw new ForgeError(`git rev-list printed ${JSON.stringify(sha.slice(0, 80))}, not a commit id`);
      addDiff(git([...PINNED_GIT_CONFIG, 'show', '--no-show-signature', '--format=', '--remerge-diff', ...PINNED_DIFF_OPTS, '--text', '-U0', sha, '--']), sha.slice(0, 12));
    }
    addDiff(git([...PINNED_GIT_CONFIG, 'diff', ...PINNED_DIFF_OPTS, '--text', '-U0', mergeBase, head, '--']), null);
    const log = git([...PINNED_GIT_CONFIG, ...LOG_PINS, 'log', '--encoding=UTF-8', '--no-show-signature', '--no-color', '--format=%x00%H%x00%B', range, '--']).split('\0');
    // Fail closed: every record starts with a full sha, and there is one per commit in the range.
    const expected = Number(git(['rev-list', '--count', range, '--']).trim());
    if (log[0] !== '' || (log.length - 1) / 2 !== expected) throw new ForgeError(`git log printed ${Math.floor((log.length - 1) / 2)} commit messages for ${expected} commits; the message scan cannot be trusted`);
    for (let i = 1; i + 1 < log.length; i += 2) {
      if (!SHA.test(log[i])) throw new ForgeError(`git log printed ${JSON.stringify(log[i].slice(0, 80))} where a commit id belongs; the message scan cannot be trusted`);
      const sha12 = log[i].slice(0, 12);
      units.push({ path: `(commit message ${sha12})`, line: 1, text: log[i + 1], file: false, commit: sha12 });
      scan.scanned.texts++;
    }
    if (opts.staged) addDiff(git([...PINNED_GIT_CONFIG, 'diff', '--cached', ...PINNED_DIFF_OPTS, '--text', '-U0', '--']), 'staged');
    scan.scanned.commits = shas.length + merges.length;
    scan.scanned.files = files.size;
    raw.push(...scanUnits(units, { config, known: knownValues(root, job.id, config) }));
  } catch (e) {
    scan.error = String((e as Error).message).split('\n')[0].slice(0, 300);
  }
  return { ...scan, ...applyAllowlist(raw, allow) };
}

/**
 * The main checkout's tracked files matching `globs`, read whole. Untracked files, symlinks and
 * other non-regular files are left out; files over 2 MiB are counted as skipped.
 */
export function scanPaths(root: string, config: Config, globs: string[]): SecretScan {
  const allow = loadAllowlist(root);
  const scan = emptyScan(allow);
  const raw: RawFinding[] = [];
  try {
    const realRoot = fs.realpathSync(root);
    const names = run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter((n) => n && inSpec(n, globs));
    const units: TextUnit[] = [];
    for (const name of names) {
      const full = path.join(root, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) {
        scan.scanned.skipped++;
        continue;
      }
      let text: string | null;
      try {
        text = readRegular(full, MAX_FILE, realRoot);
      } catch {
        continue;
      }
      if (text === null) continue;
      units.push({ path: name, line: 1, text, file: true, commit: null });
      scan.scanned.files++;
    }
    raw.push(...scanUnits(units, { config }));
  } catch (e) {
    scan.error = String((e as Error).message).split('\n')[0].slice(0, 300);
  }
  return { ...scan, ...applyAllowlist(raw, allow) };
}

/**
 * Whole files about to leave the machine as they are (a package export, not a diff): base content
 * ships too, so a key already on the default branch counts. Files over 2 MiB are counted as skipped.
 */
export function scanFiles(root: string, config: Config, files: { path: string; body: Buffer }[], opts: { id?: string } = {}): SecretScan {
  const allow = loadAllowlist(root);
  const scan = emptyScan(allow);
  const units: TextUnit[] = [];
  for (const f of files) {
    if (f.body.length > MAX_FILE) {
      scan.scanned.skipped++;
      continue;
    }
    units.push({ path: f.path, line: 1, text: f.body.toString('utf8'), file: true, commit: null });
    scan.scanned.files++;
  }
  return { ...scan, ...applyAllowlist(scanUnits(units, { config, known: opts.id ? knownValues(root, opts.id, config) : [] }), allow) };
}

/** Files a role writes besides its recorded output. */
const ROLE_EXTRAS: Record<string, string[]> = {
  builder: ['build.md', 'tasks.md'],
  integrator: ['build.md'],
  approver: ['pr.md', 'runbook.md'],
  designer: ['mockup.html'],
  retro: ['spec.md'],
};

/**
 * What an agent just wrote into the job dir: its output, its role's extras and questions.md, each
 * only when it is a regular file inside the job dir, modified since the agent started (2 s slack).
 * The entropy check is on; only fingerprints allow. Detection only: the caller never blocks on it.
 */
export function scanAgentOutputs(root: string, config: Config, job: Pick<Job, 'id' | 'agents'>, role: string): SecretScan {
  const allow = loadAllowlist(root);
  const scan = emptyScan(allow);
  const a = job.agents[role];
  const started = a?.startedAt ? Date.parse(a.startedAt) : NaN;
  const raw: RawFinding[] = [];
  try {
    const dir = fs.realpathSync(jobDir(root, job.id));
    const names = [a?.output ?? defaultAgentOutput(role, a?.round), ...(ROLE_EXTRAS[role] ?? []), 'questions.md'].filter((n): n is string => typeof n === 'string' && n.length > 0);
    const units: TextUnit[] = [];
    for (const rel of [...new Set(names.map((n) => path.normalize(n)))]) {
      const full = path.join(dir, rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || (Number.isFinite(started) && st.mtimeMs < started - 2000)) continue;
      if (st.size > MAX_FILE) {
        scan.scanned.skipped++;
        continue;
      }
      let text: string | null;
      try {
        text = readRegular(full, MAX_FILE, dir);
      } catch {
        continue;
      }
      if (text === null) continue;
      units.push({ path: rel.split(path.sep).join('/'), line: 1, text, file: false, commit: null, entropy: true });
      scan.scanned.files++;
    }
    raw.push(...scanUnits(units, { config }));
  } catch (e) {
    scan.error = String((e as Error).message).split('\n')[0].slice(0, 300);
  }
  return { ...scan, ...applyAllowlist(raw, allow) };
}

// ---------- reporting ----------

const where = (f: SecretFinding): string => (f.path.startsWith('(') ? `${f.path} line ${f.line}` : `${f.path}:${f.line}`);

/** The one-line refusal every exit gate throws: the first finding masked, with its fingerprint. */
export function refusalMessage(what: string, findings: SecretFinding[]): string {
  const f = findings[0];
  const more = findings.length > 1 ? `, and ${findings.length - 1} more` : '';
  // A known value's id is per process and never allowlisted, so the allowlist hint would mislead.
  const fix = f.kind === 'known-secret' ? 'remove it: a declared secret is never allowlisted' : `remove it, or have a human add the fingerprint to ${ALLOWLIST_FILE} in the main checkout`;
  return `possible secret in ${what}: ${f.kind} at ${clean(where(f))} (${f.excerpt}, ${f.fingerprint})${more}. Forge won't send it: ${fix}.`;
}

/**
 * Scans text Forge is about to send and throws `secret_found` on any finding the allowlist does
 * not cover, after logging `secret-found` when `id` and `gate` say where it happened.
 */
export function refuseSecrets(root: string, config: Config, units: TextUnit[], opts: { what: string; id?: string; gate?: string }): void {
  const allow = loadAllowlist(root);
  const { findings, allowed } = applyAllowlist(scanUnits(units, { config, known: opts.id ? knownValues(root, opts.id, config) : [] }), allow);
  if (!findings.length) return;
  if (opts.id && opts.gate) logSecrets(root, opts.id, opts.gate, { ...emptyScan(allow), findings, allowed }, { blocked: true });
  throw new ForgeError(refusalMessage(opts.what, findings), 'secret_found', opts.id ? `forge secrets scan ${opts.id}` : null);
}

/**
 * The `secret-found` event, logged only when there is something to report: a finding, or a scan
 * that could not finish (its `error`, already one capped line), which parks a blocked gate the same way.
 */
export function logSecrets(root: string, id: string, gate: string, scan: Pick<SecretScan, 'findings' | 'allowed'> & { error?: string | null }, extra: { blocked: boolean; round?: number; role?: string }): void {
  const count = scan.findings.length;
  if (!count && !scan.error) return;
  logEvent(root, id, 'secret-found', {
    gate,
    blocked: extra.blocked,
    count,
    allowed: scan.allowed.length,
    findings: scan.findings.slice(0, LIST_LIMIT).map((f) => ({ kind: f.kind, path: f.path, line: f.line, excerpt: f.excerpt, fingerprint: f.fingerprint })),
    more: Math.max(0, count - LIST_LIMIT),
    ...(scan.error ? { error: scan.error } : {}),
    ...(extra.round !== undefined ? { round: extra.round } : {}),
    ...(extra.role !== undefined ? { role: extra.role } : {}),
  });
  // An error that blocks nothing is a note, not something to wake anyone for. The reason code
  // only: findings, paths and fingerprints never leave the machine.
  if (count || extra.blocked) queueNotify(root, ['secret-found'], { job: id, reason: 'secret-found' });
}

/** Paths come from the builder's commits: control characters are escaped so they can't start a line. */
const clean = (s: string): string => String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const fence = (s: string): string => clean(s).replace(/```/g, "'''");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The verify step's verdict for this scan under `mode`. */
export function secretsOk(scan: Pick<SecretScan, 'findings' | 'error'>, mode: SecretMode): boolean {
  if (secretsBlock(scan.findings, mode)) return false;
  return mode === 'warn' || !scan.error;
}

function secretsHeading(scan: Pick<SecretScan, 'findings' | 'error'>, mode: SecretMode): string {
  if (scan.error) return `ERROR (${fence(scan.error)})`;
  const n = scan.findings.length;
  if (!n) return 'ok';
  return `${secretsBlock(scan.findings, mode) ? 'FAILED' : 'WARN'} (${plural(n, 'finding')})`;
}

/** One finding as a report line: kind, place, commit, masked excerpt, fingerprint. */
export const findingLine = (f: SecretFinding): string => fence(`${f.kind}  ${f.path}:${f.line}  ${f.commit ?? '-'}  ${f.excerpt}  ${f.fingerprint}`);

/** One line per finding for verify's `failure.tail`, the fingerprint cut to 12 hex. */
export function secretsTail(scan: Pick<SecretScan, 'findings' | 'error'>): string {
  if (scan.error) return `secret scan incomplete: ${clean(scan.error)}`;
  return scan.findings.map((f) => clean(`${f.kind} ${f.path}:${f.line} ${f.excerpt} ${f.fingerprint.slice(0, 'sha256:'.length + 12)}…`)).join('\n');
}

/** The `## secrets` section of verify/round-N.md, with every finding listed and masked. */
export function renderSecrets(scan: SecretScan, mode: SecretMode): string {
  const base = scan.base ? `base \`${fence(scan.base)}\`${scan.mergeBase ? ` @ ${scan.mergeBase.slice(0, 7)}` : ''}` : 'base unresolved';
  const s = scan.scanned;
  const lines = [`## secrets: ${secretsHeading(scan, mode)}`, '', `Mode \`${mode}\` · ${base} · ${plural(s.commits, 'commit')}, ${plural(s.files, 'file')}, ${plural(s.texts, 'commit message')} scanned`, ''];
  if (scan.error) {
    lines.push(`The scan could not finish${mode === 'block' ? ', which fails verify under `block`' : ''}:`, '', '```text', fence(scan.error), '```', '');
  }
  if (scan.findings.length) {
    lines.push(`### Possible secrets (${scan.findings.length})`, '', 'Kind, place, commit, masked excerpt and fingerprint; the value itself is never printed.', '', '```text', ...scan.findings.map(findingLine), '```', '');
  }
  if (scan.allowed.length) {
    lines.push(`### Allowed (${scan.allowed.length})`, '', '```text', ...scan.allowed.map((f) => `${findingLine(f)}  allowed by ${f.allowedBy}`), '```', '');
  }
  if (scan.allowlist.problems.length) lines.push('### Allowlist problems', '', ...scan.allowlist.problems.map((p) => `- ${clean(p)}`), '');
  if (scan.findings.length || scan.error) {
    lines.push(
      '### What to do',
      '',
      `- Builder: remove the value, build test tokens at runtime, and commit again. A value already committed needs a human to rewrite the branch; never encode, split or rename it to get past the scan.`,
      `- Human: if it is not a secret, add its fingerprint (or, for repository content, a path glob) to \`${ALLOWLIST_FILE}\` in the main checkout, then \`/forge approve <id>\` to scan again.`,
      '',
    );
  } else if (!scan.allowed.length) lines.push('No likely credentials in the commits, their messages or the staged changes.', '');
  return lines.join('\n');
}

/** The `secrets` key of verify's JSON. */
export function compactSecrets(scan: SecretScan, mode: SecretMode): CompactSecrets {
  return {
    mode,
    ok: secretsOk(scan, mode),
    count: scan.findings.length,
    allowed: scan.allowed.length,
    findings: scan.findings.slice(0, LIST_LIMIT).map((f) => ({ kind: f.kind, path: f.path, line: f.line })),
    more: Math.max(0, scan.findings.length - LIST_LIMIT),
    ...(scan.error ? { error: scan.error } : {}),
  };
}
