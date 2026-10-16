// The support bundle: `forge doctor --bundle` and GET /api/doctor/bundle. It gathers what a
// maintainer needs to reproduce a problem (doctor, versions, config, events, step, verify and daemon
// logs) and redacts it (lib/redact.ts) so a user can attach it to a public issue. The job dir and the
// runtime dir are agent-writable: every read is contained, never follows a link and never blocks.
// docs/CLI.md "Support bundle".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactedConfig } from './config-fields.ts';
import { worktreeRoot } from './config.ts';
import { daemonsDir, openRead, tailLines } from './daemon.ts';
import { doctor } from './doctor.ts';
import { forgeVersion } from './evals.ts';
import { PINNED_DIFF_OPTS, PINNED_GIT_CONFIG } from './integrity.ts';
import { isActive, jobDir, listJobs, loadJob } from './jobs.ts';
import { addCounts, daemonSkeleton, omitProse, omitted, redactContext, redactText } from './redact.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, validJobId } from './requests.ts';
import { realHistoryEnv, resolveBase } from './scope.ts';
import { loadStepInput, step } from './step.ts';
import type { BundleManifest, BundleSkip, Config, Job, RedactCounts } from './types.ts';
import { ForgeError, hasBinary, run } from './util.ts';
import type { ZipEntry } from './zip.ts';

export const ENTRY_CAP = 2 * 1024 * 1024;
/** How much of a file is read before prose is dropped: the skeleton is far smaller than the stream. */
const READ_CAP = 16 * 1024 * 1024;
const VERIFY_LINES = 200;
const DAEMON_LINES = 500;
const MAX_VERIFY_LOGS = 20;
const MAX_TEXT_FILES = 200;
const MAX_TEXT_DEPTH = 6;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const VERIFY_LOG = /^verify-(.+?)-(\d{4}-\d{2}-\d{2}T[0-9-]+Z|[^-]+)\.log$/;
/** A file name an agent wrote that is safe for an entry name and a terminal: no separators, escapes or `..`. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
/** What the manifest shows for a name that failed SAFE_NAME: the raw name never reaches it. */
const UNSAFE = '<unsafe name>';
const UNSAFE_REASON = 'unsafe name';

export const safeName = (name: string): boolean => SAFE_NAME.test(name) && name !== '.' && name !== '..';

export interface BundleOptions {
  /** One job; without it, every active job and the inbox and office logs. */
  job?: string;
  includeText: boolean;
  home?: string;
}

/** `forge-support-YYYY-MM-DD.zip`, in local time. */
export function bundleFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `forge-support-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.zip`;
}

/** The last ENTRY_CAP bytes of a text, behind a line that says how much went. */
export function capText(text: string, cap = ENTRY_CAP): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= cap) return text;
  // Never start mid-character: skip UTF-8 continuation bytes.
  let start = buf.length - cap;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return `[truncated: first ${start} bytes omitted]\n${buf.subarray(start).toString('utf8')}`;
}

type Opened = { fd: number; size: number } | { skip: string } | null;

/** Why an open failed, as a skip reason; null when the file is simply absent. */
function openFailure(e: unknown): string | null {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  if (code === 'ELOOP' || code === 'EMLINK') return 'symlink';
  if (/not a regular file/.test((e as Error).message)) return 'not a regular file';
  return 'unreadable';
}

const inside = (base: string, p: string): boolean => {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Opens `base/rel` for reading when its directory resolves inside `base` and the file itself is a
 * regular file reached without a link: O_NOFOLLOW | O_NONBLOCK through openRead, so a planted
 * symlink or FIFO is refused rather than followed or waited on. null when it is absent.
 */
function openContained(base: string, rel: string): Opened {
  const abs = path.join(base, rel);
  let realBase: string;
  let realDir: string;
  try {
    realBase = fs.realpathSync(base);
    realDir = fs.realpathSync(path.dirname(abs));
  } catch (e) {
    return openFailure(e) === null ? null : { skip: 'unreadable' };
  }
  if (!inside(realBase, realDir)) return { skip: 'outside the job dir' };
  try {
    const fd = openRead(abs);
    return { fd, size: fs.fstatSync(fd).size };
  } catch (e) {
    const why = openFailure(e);
    return why === null ? null : { skip: why };
  }
}

/** The last `maxBytes` of a contained file, starting on a whole line when cut; a skip reason or null otherwise. */
export function readContained(base: string, rel: string, maxBytes: number): string | { skip: string } | null {
  const o = openContained(base, rel);
  if (o === null) return null;
  if ('skip' in o) return { skip: o.skip };
  try {
    const len = Math.min(o.size, maxBytes);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(o.fd, buf, off, len - off, o.size - len + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString('utf8');
    // A cut first line may hold half a secret the scanner can no longer see; it goes.
    if (o.size > maxBytes) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return { skip: 'unreadable' };
  } finally {
    fs.closeSync(o.fd);
  }
}

/** The last `n` complete lines of a contained log, read through the same descriptor that was checked. */
function tailContained(base: string, rel: string, n: number): string[] | { skip: string } | null {
  const o = openContained(base, rel);
  if (o === null) return null;
  if ('skip' in o) return { skip: o.skip };
  try {
    return tailLines(o.fd, n, { maxBytes: READ_CAP, lineCap: ENTRY_CAP }).lines;
  } catch {
    return { skip: 'unreadable' };
  } finally {
    fs.closeSync(o.fd);
  }
}

/** A directory's entries when it is a real directory inside `base`; a skip reason for a link or anything else. */
function listContained(base: string, rel: string): fs.Dirent[] | { skip: string } | null {
  const abs = path.join(base, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { skip: 'symlink' };
  if (!st.isDirectory()) return { skip: 'not a directory' };
  try {
    if (!inside(fs.realpathSync(base), fs.realpathSync(abs))) return { skip: 'outside the job dir' };
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { skip: 'unreadable' };
  }
}

/**
 * Whether a dir under the repo resolves to exactly its own path under the repo's realpath, so no
 * link on the way (the dir, .forge/jobs, .forge/runtime) points elsewhere; null when it is absent.
 */
function wellPlaced(root: string, dir: string): boolean | null {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    return fs.realpathSync(dir) === path.join(fs.realpathSync(root), path.relative(root, dir));
  } catch (e) {
    return openFailure(e) === null ? null : false;
  }
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

function versions(): Record<string, string | null> {
  const v = (bin: string): string | null => {
    if (!hasBinary(bin)) return null;
    const r = run(bin, ['--version'], { allowFail: true });
    return r.ok ? firstLine(r.stdout) : null;
  };
  return { forge: forgeVersion(), node: process.versions.node, git: v('git'), gh: v('gh'), glab: v('glab'), os: `${os.platform()} ${os.release()} ${os.arch()}` };
}

/** A raw entry before redaction. */
interface Raw {
  name: string;
  text: string;
}

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const jsonl = (lines: string[]): string => (lines.length ? lines.join('\n') + '\n' : '');

/** One JSON line, prose dropped unless text is included; a line that doesn't parse goes whole. */
function eventLine(line: string, includeText: boolean): string {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return JSON.stringify(includeText ? line : omitted(line));
  }
  return JSON.stringify(includeText ? v : omitProse(v));
}

/** The worktree when job.json's points exactly at `<worktrees>/<id>`, both resolved; job.json is agent-writable. */
function ownWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'worktree'>): string | null {
  if (typeof job.worktree !== 'string' || !path.isAbsolute(job.worktree)) return null;
  try {
    const real = fs.realpathSync(job.worktree);
    return real === fs.realpathSync(path.join(worktreeRoot(root, config), job.id)) ? real : null;
  } catch {
    return null;
  }
}

/** The branch's net diff from its merge base, run only in the job's own worktree and never from job.branch. */
function jobDiff(root: string, config: Config, job: Job): string | { skip: string } {
  const wt = ownWorktree(root, config, job);
  if (!wt) return { skip: 'no worktree of this repo' };
  try {
    const { mergeBase } = resolveBase(wt, config, job);
    if (!SHA.test(mergeBase)) return { skip: 'no merge base' };
    const r = run('git', [...PINNED_GIT_CONFIG, 'diff', ...PINNED_DIFF_OPTS, mergeBase, 'HEAD', '--'], { cwd: wt, env: realHistoryEnv(), allowFail: true });
    return r.ok ? r.stdout : { skip: 'git diff failed' };
  } catch {
    return { skip: 'no merge base' };
  }
}

/** Every `*.md` under the job dir but verify/, as paths relative to it, without following links. */
function markdownFiles(dir: string, skipped: BundleSkip[], prefix: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    const list = listContained(dir, rel);
    if (!list) return;
    if (!Array.isArray(list)) return void skipped.push({ name: `${prefix}/${rel}`, reason: list.skip });
    for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!safeName(d.name)) {
        if (d.isDirectory() || d.name.endsWith('.md')) skipped.push({ name: `${prefix}/${rel ? `${rel}/` : ''}${UNSAFE}`, reason: UNSAFE_REASON });
        continue;
      }
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!(rel === '' && d.name === 'verify') && depth < MAX_TEXT_DEPTH) walk(child, depth + 1);
      } else if (d.name.endsWith('.md') && out.length < MAX_TEXT_FILES) out.push(child);
    }
  };
  walk('', 0);
  return out;
}

/** One job's raw entries. */
function jobEntries(root: string, config: Config, id: string, includeText: boolean, skipped: BundleSkip[], daemons: string | null): Raw[] {
  const out: Raw[] = [];
  const dir = jobDir(root, id);
  const pre = `jobs/${id}`;
  const add = (name: string, r: string | { skip: string } | null, map: (text: string) => string) => {
    if (r === null) return;
    if (typeof r === 'object') return void skipped.push({ name, reason: r.skip });
    out.push({ name, text: map(r) });
  };
  const jobText = readContained(dir, 'job.json', READ_CAP);
  add(`${pre}/job.json`, jobText, (t) => {
    try {
      const v = JSON.parse(t);
      return pretty(includeText ? v : omitProse(v));
    } catch {
      return pretty({ error: 'job.json does not parse' });
    }
  });
  add(`${pre}/events.jsonl`, readContained(dir, 'events.jsonl', READ_CAP), (t) => jsonl(t.split('\n').filter((l) => l.trim()).map((l) => eventLine(l, includeText))));
  let stepOut: unknown;
  try {
    stepOut = step(loadStepInput(root, config, id));
  } catch (e) {
    stepOut = { error: (e as Error).message };
  }
  out.push({ name: `${pre}/step.json`, text: pretty(includeText ? stepOut : omitProse(stepOut)) });

  const verify = listContained(dir, 'verify');
  if (verify && !Array.isArray(verify)) skipped.push({ name: `${pre}/verify`, reason: verify.skip });
  else if (Array.isArray(verify)) {
    const rounds = verify.map((d) => ({ d, m: /^round-(\d+)\.md$/.exec(d.name) })).filter((x) => x.m).sort((a, b) => Number(b.m![1]) - Number(a.m![1]));
    const newest = rounds[0]?.d.name;
    if (newest) add(`${pre}/verify/${newest}`, readContained(dir, `verify/${newest}`, READ_CAP), (t) => lastLines(t, VERIFY_LINES));
  }

  const logs = listContained(dir, 'logs');
  if (logs && !Array.isArray(logs)) skipped.push({ name: `${pre}/logs`, reason: logs.skip });
  else if (Array.isArray(logs)) {
    const byStep = new Map<string, string>();
    for (const name of logs.map((d) => d.name).sort().reverse()) {
      if (!safeName(name)) {
        if (name.startsWith('verify-')) skipped.push({ name: `${pre}/logs/${UNSAFE}`, reason: UNSAFE_REASON });
        continue;
      }
      const m = VERIFY_LOG.exec(name);
      if (m && !byStep.has(m[1])) byStep.set(m[1], name);
    }
    for (const name of [...byStep.keys()].sort().slice(0, MAX_VERIFY_LOGS).map((k) => byStep.get(k)!)) {
      add(`${pre}/logs/${name}`, readContained(dir, `logs/${name}`, READ_CAP), (t) => lastLines(t, VERIFY_LINES));
    }
  }

  const daemon = daemons ? tailContained(daemons, `${id}.log`, DAEMON_LINES) : null;
  if (Array.isArray(daemon)) out.push({ name: `${pre}/daemon.log`, text: daemonText(daemon, includeText) });
  else if (daemon) skipped.push({ name: `${pre}/daemon.log`, reason: daemon.skip });

  if (includeText) {
    for (const rel of markdownFiles(dir, skipped, pre)) add(`${pre}/text/${rel}`, readContained(dir, rel, ENTRY_CAP), (t) => t);
    let job: Job | null = null;
    try {
      job = loadJob(root, id);
    } catch {}
    if (job) add(`${pre}/diff.patch`, jobDiff(root, config, job), (t) => t);
  }
  return out;
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n') + '\n';
}

/** A daemon log's lines: whole under --include-text, skeletons otherwise. */
const daemonText = (lines: string[], includeText: boolean): string => jsonl(includeText ? lines : lines.map(daemonSkeleton));

/**
 * The bundle's entries, redacted, with manifest.json last. Throws a ForgeError for an invalid or
 * unknown job id before any path is built from it; any file it can't read safely is skipped.
 */
export async function buildBundle(
  root: string,
  config: Config,
  initialized: boolean,
  opts: BundleOptions,
): Promise<{ entries: ZipEntry[]; manifest: BundleManifest }> {
  const { includeText } = opts;
  let ids: string[];
  if (opts.job !== undefined) {
    if (!validJobId(opts.job)) throw new ForgeError(`invalid job id ${JSON.stringify(String(opts.job).slice(0, 80))}`);
    loadJob(root, opts.job);
    ids = [opts.job];
  } else ids = listJobs(root).filter(isActive).map((j) => j.id).filter(validJobId).sort();

  const ctx = redactContext(root, config, opts.home);
  const skipped: BundleSkip[] = [];
  const raw: Raw[] = [
    { name: 'doctor.json', text: pretty(await doctor(root, config, initialized)) },
    { name: 'versions.json', text: pretty(versions()) },
    { name: 'config.json', text: pretty(redactedConfig(config)) },
  ];
  // Every read is contained in its base dir, so the base itself must sit where it should: a linked
  // .forge/runtime or job dir would move the confinement somewhere else.
  const daemonsBase = daemonsDir(root);
  const daemonsOk = wellPlaced(root, daemonsBase);
  if (daemonsOk === false) skipped.push({ name: 'daemon', reason: 'symlink' });
  const daemons = daemonsOk ? daemonsBase : null;
  if (opts.job === undefined && daemons) {
    for (const [scope, name] of [[INBOX_SCOPE, 'inbox'], [OFFICE_SCOPE, 'office']] as const) {
      const r = tailContained(daemons, `${scope}.log`, DAEMON_LINES);
      if (Array.isArray(r)) raw.push({ name: `daemon/${name}.log`, text: daemonText(r, includeText) });
      else if (r) skipped.push({ name: `daemon/${name}.log`, reason: r.skip });
    }
  }
  for (const id of ids) {
    const dir = jobDir(root, id);
    if (!wellPlaced(root, dir)) {
      let link = false;
      try {
        link = fs.lstatSync(dir).isSymbolicLink();
      } catch {}
      skipped.push({ name: `jobs/${id}`, reason: link ? 'symlink' : 'outside the job dir' });
      continue;
    }
    raw.push(...jobEntries(root, config, id, includeText, skipped, daemons));
  }

  const redactions: RedactCounts = { secrets: 0, paths: 0, emails: 0, logins: 0 };
  const redact = (s: string): string => {
    const r = redactText(s, ctx);
    addCounts(redactions, r.counts);
    return r.text;
  };
  const entries: ZipEntry[] = raw.map((r) => ({ name: redact(r.name), data: Buffer.from(capText(redact(r.text)), 'utf8') }));
  const manifest: BundleManifest = {
    createdAt: new Date().toISOString(),
    forgeVersion: forgeVersion(),
    includeText,
    jobs: ids.map((id) => redactText(id, ctx).text),
    entries: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
    skipped: skipped.map((s) => ({ name: redact(s.name), reason: s.reason })),
    redactions,
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(redactText(pretty(manifest), ctx).text, 'utf8') });
  return { entries, manifest };
}
