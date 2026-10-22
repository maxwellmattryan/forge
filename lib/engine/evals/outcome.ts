// A merged job's outcome: whether its merge was reverted, drew follow-up bug issues or churned
// inside a window after the merge. It is the escape signal that pre-merge metrics cannot see, and
// what the autonomy rate (lib/engine/evals/autonomy.ts) judges a job on once the window has closed.
//
// GitHub titles, bodies and labels are untrusted: they are only compared, never stored, logged or
// rendered. What is stored is integers, shas that pass isSha, and refs rebuilt from the configured
// slug and an integer.
import { listArchived } from '../../core/job/archive.ts';
import { fetchCommit, isSha } from '../pr/delta.ts';
import { listJobs, logEvent, setJob } from '../../core/job/store.ts';
import { isSafeBranch, isSafeRemote } from '../project/member-repos.ts';
import { repoSlug } from '../pr/lifecycle.ts';
import { OUTCOME_REF } from '../../core/job/schema.ts';
import type { Config, Job, JobOutcome } from '../../core/types.ts';
import { gh } from '../../integrations/github/gh.ts';
import { git } from '../../integrations/git/runner.ts';

/** A read-only gh call: the default runs gh in the root, tests pass a fake. */
export type GhFn = (args: string[]) => { ok: boolean; stdout: string };

/** Commits Forge itself landed, which never count as churn. */
export interface ForgeCommits {
  shas: Set<string>;
  prNumbers: Set<number>;
}

export interface OutcomeDeps {
  gh: GhFn;
  now: () => Date;
  forge?: ForgeCommits;
}

const DAY_MS = 86_400_000;
const REMEASURE_MS = DAY_MS;
// A check left null by a failed fetch or gh call gets this many measurements before it settles.
const MAX_ATTEMPTS = 3;
const PER_SYNC = 10;
const MAX_JOB_FILES = 200;
const MAX_REFS = 20;
const MAX_TEXT = 65_536;
const DEFAULT_WINDOW_DAYS = 14;

const defaultGh = (root: string): GhFn => (args) => gh(root, args, { allowFail: true });

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const iso = (t: number): string => new Date(t).toISOString();
const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function parseJson(r: { ok: boolean; stdout: string }): unknown {
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** Whether `job` needs a measurement now: merged, and no outcome, or an open one that is closed or a day old. */
export function outcomeDue(job: Job, now: Date): boolean {
  if (job.kind === 'eval' || job.pr?.state !== 'MERGED') return false;
  const o = job.outcome;
  if (!o) return true;
  if (o.status !== 'open') return false;
  const at = now.getTime();
  return at >= Date.parse(o.closesAt) || at - Date.parse(o.measuredAt) > REMEASURE_MS;
}

/**
 * The number of the first merged PR inside [from, to] that reverts PR `number`: its title is
 * exactly `Revert "<title>"`, or its body has a line `Reverts <slug>#<number>`.
 */
export function matchRevertPr(prs: unknown, q: { title: string; number: number; slug: string; from: number; to: number }): number | null {
  if (!Array.isArray(prs)) return null;
  const want = `Revert "${q.title}"`;
  const slug = q.slug.toLowerCase();
  const hits: { n: number; at: number }[] = [];
  for (const p of prs) {
    if (!p || typeof p !== 'object') continue;
    const { number, title, body, mergedAt } = p as Record<string, unknown>;
    const at = timeOf(mergedAt);
    if (!isPositiveInt(number) || number === q.number || at === null || at < q.from || at > q.to) continue;
    const byTitle = typeof title === 'string' && title === want;
    const byBody = text(body)
      .split(/\r?\n/)
      .some((line) => {
        const m = /^Reverts ([^\s#]+)#(\d{1,10})$/.exec(line.trim());
        return Boolean(m) && m![1].toLowerCase() === slug && Number(m![2]) === q.number;
      });
    if (byTitle || byBody) hits.push({ n: number, at });
  }
  hits.sort((a, b) => a.at - b.at || a.n - b.n);
  return hits[0]?.n ?? null;
}

/** A job issue as `owner/repo` and number, or null when it is not a GitHub issue. */
function issueKey(ref: string | null, slug: string): { slug: string; n: number } | null {
  if (!ref) return null;
  const bare = /^#?(\d{1,10})$/.exec(ref);
  if (bare) return { slug, n: Number(bare[1]) };
  const q = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,10})$/.exec(ref);
  return q ? { slug: q[1], n: Number(q[2]) } : null;
}

/** Whether `body` cites `slug`#`n` as a URL, as `slug#n`, or (same repo only) as a bare `#n`. */
function cites(body: string, target: { slug: string; n: number; kind: 'pull' | 'issues' }, home: string): boolean {
  const s = escapeRe(target.slug);
  const url = new RegExp(`/${s}/${target.kind}/${target.n}(?!\\d)`, 'i');
  const qualified = new RegExp(`(?:^|[^A-Za-z0-9_./-])${s}#${target.n}(?!\\d)`, 'i');
  if (url.test(body) || qualified.test(body)) return true;
  if (target.slug.toLowerCase() !== home.toLowerCase()) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9/])#${target.n}(?!\\d)`).test(body);
}

/**
 * The `slug#n` refs of the bug issues created inside [from, to], other than the job's own, whose
 * title or body cites the job's PR or one of its issues.
 */
export function matchFollowUps(list: unknown, q: { slug: string; prNumber: number; issues: (string | null)[]; from: number; to: number }): string[] {
  if (!Array.isArray(list)) return [];
  const own = q.issues.map((r) => issueKey(r, q.slug)).filter((k): k is { slug: string; n: number } => k !== null);
  const isOwn = (n: number) => own.some((k) => k.n === n && k.slug.toLowerCase() === q.slug.toLowerCase());
  const targets = [{ slug: q.slug, n: q.prNumber, kind: 'pull' as const }, ...own.map((k) => ({ ...k, kind: 'issues' as const }))];
  const refs: string[] = [];
  for (const i of list) {
    if (!i || typeof i !== 'object') continue;
    const { number, title, body, createdAt } = i as Record<string, unknown>;
    const at = timeOf(createdAt);
    if (!isPositiveInt(number) || at === null || at < q.from || at > q.to || isOwn(number)) continue;
    const said = `${text(title)}\n${text(body)}`;
    if (!targets.some((t) => cites(said, t, q.slug))) continue;
    const ref = `${q.slug}#${number}`;
    if (OUTCOME_REF.test(ref) && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

const hasCommit = (cwd: string, sha: string): boolean => git(cwd, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).ok;

/** The first commit on `ref` after `mergeSha`, inside [from, until], whose message says it reverts it. */
export function findRevertCommit(cwd: string, ref: string, mergeSha: string, from: string, until: string): string | null {
  if (!isSha(mergeSha)) return null;
  const r = git(cwd, ['log', '--format=%H', '-F', `--grep=This reverts commit ${mergeSha}`, `--since=${from}`, `--until=${until}`, `${mergeSha}..${ref}`, '--'], { allowFail: true });
  if (!r.ok) return null;
  const shas = r.stdout.split('\n').map((s) => s.trim()).filter(isSha);
  // git log lists newest first.
  return shas.at(-1) ?? null;
}

/**
 * First-parent commits on `ref` after `mergeSha`, committed before `until`, that touch a file the
 * merge changed against its first parent, minus Forge's own. Null when git can't read the merge.
 */
export function measureChurn(cwd: string, ref: string, mergeSha: string, until: string, forge: ForgeCommits): JobOutcome['churn'] {
  if (!isSha(mergeSha)) return null;
  const diff = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${mergeSha}^1`, mergeSha, '--'], { allowFail: true });
  if (!diff.ok) return null;
  const files = diff.stdout.split('\0').filter(Boolean).slice(0, MAX_JOB_FILES);
  if (!files.length) return { commits: 0, lines: 0, files: 0 };
  const log = git(
    cwd,
    ['--literal-pathspecs', 'log', '--first-parent', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--format=%x01%H%x02%s', `--until=${until}`, `${mergeSha}..${ref}`, '--', ...files],
    { allowFail: true },
  );
  if (!log.ok) return null;
  let commits = 0, lines = 0;
  const touched = new Set<string>();
  for (const rec of log.stdout.split('\x01')) {
    const sep = rec.indexOf('\x02');
    if (sep < 0) continue;
    const sha = rec.slice(0, sep);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const rest = rec.slice(sep + 1);
    const end = rest.search(/[\n\0]/);
    const subject = end < 0 ? rest : rest.slice(0, end);
    if (isForgeCommit(sha, subject, forge)) continue;
    let counted = false;
    for (const entry of (end < 0 ? '' : rest.slice(end)).split('\0')) {
      const m = entry.replace(/^\n+/, '').match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
      if (!m) continue;
      counted = true;
      if (m[1] !== '-') lines += Number(m[1]);
      if (m[2] !== '-') lines += Number(m[2]);
      touched.add(m[3]);
    }
    if (counted) commits++;
  }
  return { commits, lines, files: touched.size };
}

/** Another job's merge: its recorded merge sha, its squash subject `… (#N)`, or GitHub's merge commit. */
function isForgeCommit(sha: string, subject: string, forge: ForgeCommits): boolean {
  if (forge.shas.has(sha)) return true;
  const squash = /\(#(\d{1,10})\)$/.exec(subject);
  if (squash && forge.prNumbers.has(Number(squash[1]))) return true;
  const merge = /^Merge pull request #(\d{1,10}) /.exec(subject);
  return Boolean(merge) && forge.prNumbers.has(Number(merge![1]));
}

/** Every live and archived job's merge sha and PR number. */
function forgeCommits(root: string): ForgeCommits {
  const shas = new Set<string>();
  const prNumbers = new Set<number>();
  for (const j of [...listJobs(root), ...listArchived(root).map((a) => a.job)]) {
    if (j.outcome?.mergeSha) shas.add(j.outcome.mergeSha);
    if (isPositiveInt(j.pr?.number)) prNumbers.add(j.pr!.number);
  }
  return { shas, prNumbers };
}

/** The base branch's remote-tracking ref when it exists, else its local branch; null for an unsafe name. */
function baseRef(root: string, config: Config, job: Job): string | null {
  const base = job.base ?? config.git.base;
  if (!isSafeBranch(base)) return null;
  const remote = config.git.remote;
  if (isSafeRemote(remote) && isSafeBranch(remote)) {
    const tracking = `refs/remotes/${remote}/${base}`;
    if (git(root, ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`, '--'], { allowFail: true }).ok) return tracking;
  }
  return `refs/heads/${base}`;
}

function slugOf(root: string, config: Config): string | null {
  try {
    const s = repoSlug(root, config);
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** Measures one merged job's outcome. It never throws for a failed git or gh call: that check stays null. */
export function measureOutcome(root: string, config: Config, job: Job, deps: Partial<OutcomeDeps> = {}): JobOutcome {
  const gh = deps.gh ?? defaultGh(root);
  const at = (deps.now ?? (() => new Date()))().getTime();
  const prev = job.outcome;
  const windowDays = config.outcomes?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const number = isPositiveInt(job.pr?.number) ? job.pr!.number : null;
  const slug = slugOf(root, config);
  const reasons: string[] = [];
  let title: string | null = null;
  let ghMergeSha: string | null = null;
  let ghMergedAt: number | null = null;
  if (slug && number) {
    const view = parseJson(gh(['pr', 'view', String(number), '-R', slug, '--json', 'title,mergeCommit,mergedAt'])) as Record<string, any> | undefined;
    if (view && typeof view === 'object') {
      // Held in memory for matching only.
      if (typeof view.title === 'string') title = view.title;
      if (isSha(view.mergeCommit?.oid)) ghMergeSha = view.mergeCommit.oid.toLowerCase();
      ghMergedAt = timeOf(view.mergedAt);
    }
  }
  let mergedAt = timeOf(job.pr?.mergedAt) ?? ghMergedAt ?? timeOf(prev?.mergedAt);
  if (mergedAt === null) {
    reasons.push('no merge time');
    mergedAt = timeOf(job.finishedAt) ?? timeOf(job.updatedAt) ?? at;
  }
  const closes = mergedAt + windowDays * DAY_MS;
  const from = iso(mergedAt);
  const until = iso(closes);
  const mergeSha = ghMergeSha ?? prev?.mergeSha ?? null;
  const ref = baseRef(root, config, job);
  let found = false;
  if (!mergeSha) reasons.push('no merge commit');
  else if (!ref) reasons.push('unsafe base branch');
  else {
    found = hasCommit(root, mergeSha) || (fetchCommit(root, config.git.remote, mergeSha) && hasCommit(root, mergeSha));
    if (!found) reasons.push('merge commit not found');
  }

  let reverted: boolean | null = null;
  let revertedBy: JobOutcome['revertedBy'] = null;
  let churn: JobOutcome['churn'] = null;
  if (found) {
    const sha = findRevertCommit(root, ref!, mergeSha!, from, until);
    if (sha) {
      reverted = true;
      revertedBy = { kind: 'commit', sha };
    } else if (slug && number && title !== null && isSafeBranch(job.base ?? config.git.base)) {
      const prs = parseJson(gh(['pr', 'list', '-R', slug, '--state', 'merged', '--base', job.base ?? config.git.base, '--search', 'Revert in:title', '--json', 'number,title,body,mergedAt', '--limit', '100']));
      if (prs !== undefined) {
        const n = matchRevertPr(prs, { title, number, slug, from: mergedAt, to: closes });
        reverted = n !== null;
        revertedBy = n !== null ? { kind: 'pr', number: n } : null;
      }
    }
    churn = measureChurn(root, ref!, mergeSha!, until, deps.forge ?? forgeCommits(root));
  }

  let followUps: JobOutcome['followUps'] = null;
  let followUpRefs: string[] = [];
  if (config.tracker.kind !== 'github') followUps = 'unsupported';
  else if (slug && number) {
    const issues = parseJson(gh(['issue', 'list', '-R', slug, '--state', 'all', '--label', 'bug', '--search', `created:>=${from.slice(0, 10)}`, '--json', 'number,url,title,body,createdAt', '--limit', '100']));
    if (issues !== undefined) {
      const refs = matchFollowUps(issues, { slug, prNumber: number, issues: job.issues.filter((i) => i.tracker === 'github').map((i) => i.ref), from: mergedAt, to: closes });
      followUps = refs.length;
      followUpRefs = refs.slice(0, MAX_REFS);
    }
  }

  const complete = reverted !== null && followUps !== null && churn !== null;
  const attempts = (prev?.attempts ?? 0) + (complete ? 0 : 1);
  const status = at >= closes && (complete || attempts >= MAX_ATTEMPTS) ? 'final' : 'open';
  return {
    status,
    windowDays,
    mergedAt: from,
    closesAt: until,
    mergeSha: mergeSha && isSha(mergeSha) ? mergeSha : null,
    reverted,
    revertedBy,
    followUps,
    followUpRefs,
    churn,
    measuredAt: iso(at),
    attempts,
    ...(reasons.length ? { reason: reasons.join(', ') } : {}),
  };
}

/**
 * `forge sync`'s outcome pass: measures up to `limit` due merged jobs, never-measured first, then
 * the longest unmeasured, and records each with setJob (fields only) and one `outcome` event.
 */
export function measureOutcomes(root: string, config: Config, opts: { limit?: number; now?: Date; gh?: GhFn } = {}): { measured: string[]; finalized: string[] } {
  const measured: string[] = [];
  const finalized: string[] = [];
  if (!config.pr?.enabled) return { measured, finalized };
  const now = opts.now ?? new Date();
  const due = listJobs(root)
    .filter((j) => outcomeDue(j, now))
    .sort((a, b) => Number(Boolean(a.outcome)) - Number(Boolean(b.outcome)) || String(a.outcome?.measuredAt ?? '').localeCompare(String(b.outcome?.measuredAt ?? '')) || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? PER_SYNC);
  if (!due.length) return { measured, finalized };
  if (isSafeRemote(config.git.remote)) git(root, ['fetch', '--quiet', config.git.remote, '--prune'], { write: true, allowFail: true });
  const forge = forgeCommits(root);
  const gh = opts.gh ?? defaultGh(root);
  for (const job of due) {
    const outcome = measureOutcome(root, config, job, { gh, now: () => now, forge });
    setJob(root, job.id, { fields: { outcome } });
    logEvent(root, job.id, 'outcome', { status: outcome.status, reverted: outcome.reverted, followUps: outcome.followUps, churnCommits: outcome.churn?.commits ?? null });
    measured.push(job.id);
    if (outcome.status === 'final') finalized.push(job.id);
    if (outcome.mergeSha) forge.shas.add(outcome.mergeSha);
  }
  return { measured, finalized };
}
