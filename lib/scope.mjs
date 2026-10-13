// @ts-check
// `forge job scope`: which files a job changed that its spec's Approach never named.
import fs from 'node:fs';
import path from 'node:path';
import { loadJob, jobDir } from './jobs.mjs';
import { exists } from './paths.mjs';
import { ForgeError, now, run } from './util.mjs';

const LIST_LIMIT = 20;

/**
 * The text under the `Approach` heading, up to the next heading of the same or higher level.
 * Headings inside fenced code blocks don't count, so an example spec quoted in a fence can't end it.
 * @param {string} specText @returns {string | null}
 */
export function approachSection(specText) {
  const lines = specText.split(/\r?\n/);
  let level = 0;
  let fenced = false;
  /** @type {string[] | null} */
  let out = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (out) {
      if (h && h[1].length <= level) break;
      out.push(line);
    } else if (h && /^approach$/i.test(h[2])) {
      level = h[1].length;
      out = [];
    }
  }
  return out ? out.join('\n') : null;
}

/** @param {string} raw @returns {string | null} */
function cleanToken(raw) {
  let t = raw;
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/^["'`([]+/, '').replace(/\)\*+$/, ')').replace(/["'`)\]]+$/, '').replace(/[.,;:]+$/, '');
    // Markdown emphasis wrapping a word (`**lib/x.mjs**`) is not a glob.
    for (const m of ['**', '__', '*', '_']) if (t.length > 2 * m.length && t.startsWith(m) && t.endsWith(m)) t = t.slice(m.length, -m.length);
  }
  t = t.replace(/:\d+(?:-\d+)?$/, '').replace(/#L\d+(?:-L?\d+)?$/, '').replace(/^\.\//, '');
  if (!t || t.includes('://') || /\s/.test(t) || /^[-<$]/.test(t)) return null;
  if (!(t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t) || t.includes('*'))) return null;
  return t;
}

/** One level of brace expansion: `lib/{a,b}.mjs` → `lib/a.mjs`, `lib/b.mjs`. @param {string} t */
function expandBraces(t) {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(t);
  return m ? m[2].split(',').map((alt) => m[1] + alt + m[3]) : [t];
}

/**
 * Path-like tokens named in the Approach section: backtick spans and whitespace-separated words.
 * Prose that happens to look like a path survives, which only makes the check more lenient.
 * @param {string} specText @returns {string[]}
 */
export function approachPaths(specText) {
  const section = approachSection(specText);
  if (section === null) return [];
  const spans = [...section.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  // Words containing a backtick are already covered by their span; re-reading them only adds noise.
  const words = section.split(/\s+/).filter((w) => w && !w.includes('`'));
  const out = new Set();
  for (const raw of [...spans, ...words]) {
    const t = cleanToken(raw);
    if (!t) continue;
    for (const e of expandBraces(t)) if (e) out.add(e);
  }
  return [...out];
}

/** `**` crosses directories, `*` and `?` do not; anchored to the whole string. @param {string} glob */
function globToRegExp(glob) {
  const body = glob
    .split('**/')
    .map((part) =>
      part
        .split('**')
        .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

/**
 * Whether a changed file is covered by any token named in the spec.
 * @param {string} file @param {string[]} tokens
 */
export function inSpec(file, tokens) {
  const base = path.posix.basename(file);
  return tokens.some((t) => {
    if (file === t) return true;
    if (t.endsWith('/') ? file.startsWith(t) : file.startsWith(`${t}/`)) return true;
    if (t.includes('*') || t.includes('?')) {
      const re = globToRegExp(t.replace(/\/$/, ''));
      // A slash-free glob (`*.test.mjs`) is read like a bare filename and matched against the basename too.
      return re.test(file) || (!t.includes('/') && re.test(base));
    }
    return !t.includes('/') && base === t;
  });
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();

/**
 * The ref a job branch is compared against: `<remote>/<base>` when it resolves, else the local base.
 * Shared by `forge job scope` and verify's integrity report so both read the same diff.
 * @param {string} cwd @param {any} config @param {any} job
 * @returns {{baseRef: string, mergeBase: string}}
 */
export function resolveBase(cwd, config, job) {
  const resolves = (/** @type {string} */ ref) => run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, allowFail: true }).ok;
  const remoteRef = `${config.git.remote}/${job.base}`;
  const baseRef = resolves(remoteRef) ? remoteRef : resolves(job.base) ? job.base : null;
  if (!baseRef) throw new ForgeError(`base ${job.base} not found`);
  return { baseRef, mergeBase: git(cwd, ['merge-base', baseRef, 'HEAD']) };
}

/**
 * Compares the committed diff since the merge-base with the spec's Approach paths and writes scope.md.
 * Read-only for job state: no event, no job.json change.
 * @param {string} root @param {any} config @param {string} id
 */
export function jobScope(root, config, id) {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const dir = jobDir(root, job.id);
  const specFile = path.join(dir, 'spec.md');
  if (!exists(specFile)) throw new ForgeError(`job ${id} has no spec.md`);
  const cwd = job.worktree;
  const { baseRef, mergeBase } = resolveBase(cwd, config, job);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const dirty = git(cwd, ['status', '--porcelain']) !== '';
  const changedFiles = git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']).split('\n').filter(Boolean).sort();

  const specText = fs.readFileSync(specFile, 'utf8');
  const approach = approachSection(specText) !== null;
  const tokens = approachPaths(specText);
  const inside = changedFiles.filter((f) => inSpec(f, tokens));
  const outside = changedFiles.filter((f) => !inSpec(f, tokens));

  const file = path.join(dir, 'scope.md');
  fs.writeFileSync(file, renderScope({ baseRef, mergeBase, head, dirty, approach, tokens, inside, outside, changed: changedFiles.length }));
  return {
    id: job.id,
    base: baseRef,
    mergeBase,
    head,
    dirty,
    approach,
    specPaths: tokens.length,
    changed: changedFiles.length,
    inSpec: inside.length,
    outOfSpec: outside.slice(0, LIST_LIMIT),
    more: Math.max(0, outside.length - LIST_LIMIT),
    file: path.relative(root, file),
  };
}

/**
 * @param {{baseRef:string, mergeBase:string, head:string, dirty:boolean, approach:boolean, tokens:string[], inside:string[], outside:string[], changed:number}} s
 */
function renderScope(s) {
  const list = (/** @type {string[]} */ xs) => (xs.length ? xs.map((x) => `- \`${x}\``) : ['- none']);
  return [
    `SCOPE: ${s.outside.length} of ${s.changed} changed files outside spec Approach`,
    '',
    `Base ${s.baseRef} @ ${s.mergeBase.slice(0, 12)} · HEAD ${s.head.slice(0, 12)} · ${now()}`,
    ...(s.approach ? [] : ['> spec.md has no Approach section: every changed file counts as out of scope.']),
    ...(s.dirty ? ['> Worktree has uncommitted changes; they are not included.'] : []),
    '',
    `## Out of spec (${s.outside.length})`,
    ...list(s.outside),
    `## In spec (${s.inside.length})`,
    ...list(s.inside),
    `## Paths named in Approach (${s.tokens.length})`,
    ...list(s.tokens),
    '',
  ].join('\n');
}
