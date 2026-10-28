// The held push: what `forge pr open` won't push until a person approves it, and why.
// A CI config change runs on the remote the moment it is pushed, a security review that isn't PASS
// has findings nobody accepted, and a secret the scan only reported is still on the branch, so these
// hold the push itself, not only the merge. `forge pr open` is the one enforcer (refusePushHold in
// lib/engine/pr/open.ts); step only parks on the `push-held` event it logs (PR13).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isForemanActor } from '#core/job/store.ts';
import type { Config, Job, JobEvent } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { resolveBase } from '../pipeline/scope.ts';
import { latestSecurity } from '../pipeline/moves/foreman-gates.ts';
import { fold } from './floor.ts';
import { isCiPath } from './integrity.ts';
import { diffEntries } from './protected.ts';
import type { DiffEntry } from './protected.ts';
import type { SecretMode } from './secrets.ts';
import type { SecretScan } from './types.ts';

/** Every held-push park reason starts with this; the dashboard and step's tell key on it. */
export const PUSH_HELD_PREFIX = 'push held: ';

/** One CI file the push would change: `<repo>:<path>` for a member repo, its blob null when deleted. */
export interface CiChange {
  path: string;
  blob: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LINK_MODES = new Set(['120000', '160000']);
/** Leading directories of the CI paths: a link here replaces every workflow under it. */
const CI_DIRS = new Set(['.github', '.github/workflows', '.circleci', '.buildkite', '.forge', '.forge/ci']);
/**
 * Paths printed in a reason: protectedReason's class (shellLine-safe, `:` for a member repo), never an
 * option, and short enough that three of them, the count and the digest stay inside PR13's 400 characters.
 */
const REASON_PATH = /^[A-Za-z0-9._:/@+-]{1,100}$/;

/** A path, folded as a case-insensitive checkout reads it, is CI config or a CI leading directory (a link there). */
function ciName(p: string, link: boolean): boolean {
  const f = fold(p);
  return isCiPath(f, true) || (link && CI_DIRS.has(f));
}

/** The CI entries of a `--no-renames` diff: CI paths, and links (either side) at a CI leading directory. */
export function ciEntries(entries: DiffEntry[]): DiffEntry[] {
  return entries.filter((e) => ciName(e.path, LINK_MODES.has(e.oldMode) || LINK_MODES.has(e.newMode)));
}

/**
 * Whether a protected-paths hit (`<path>` or `<repo>:<path>`) is CI config. A hit carries no mode,
 * so a CI leading directory counts as a link; the part after the first `:` is checked too, which
 * can only over-match a root path that contains one.
 */
export function isCiHit(p: string): boolean {
  if (ciName(p, true)) return true;
  const i = p.indexOf(':');
  return i >= 0 && ciName(p.slice(i + 1), true);
}

/**
 * The CI files one repo's push would change: those the branch changes from merge-base(base, head)
 * and that also differ from `pushed`, what Forge last pushed (a locked job field, never a
 * remote-tracking ref), when it is a commit here; every branch-changed CI file when nothing was
 * pushed. Throws when git can't answer, so the caller holds the push.
 */
export function pushCiChanges(cwd: string, config: Config, base: Pick<Job, 'base'>, head: string, pushed: string | null | undefined, repo?: string): CiChange[] {
  if (!FULL_SHA.test(head)) throw new ForgeError(`${JSON.stringify(String(head).slice(0, 80))} is not a commit id`);
  const env = historyEnv();
  const real = fs.realpathSync(cwd);
  const mergeBase = resolveBase(real, config, base, head).mergeBase;
  if (!FULL_SHA.test(mergeBase)) throw new ForgeError(`merge-base ${JSON.stringify(mergeBase.slice(0, 80))} is not a commit id`);
  let ci = ciEntries(diffEntries(real, mergeBase, head, env));
  if (ci.length && typeof pushed === 'string' && FULL_SHA.test(pushed) && git(real, ['cat-file', '-e', `${pushed}^{commit}`], { env, allowFail: true }).ok) {
    const since = new Set(diffEntries(real, pushed, head, env).map((e) => e.path));
    ci = ci.filter((e) => since.has(e.path));
  }
  return ci.map((e) => ({ path: repo === undefined ? e.path : `${repo}:${e.path}`, blob: e.newMode === '000000' ? null : e.newBlob }));
}

const digest16 = (keys: string[]): string => {
  const h = createHash('sha256');
  for (const k of [...keys].sort()) h.update(k);
  return h.digest('hex').slice(0, 16);
};

/** At most 3 printable paths, the rest counted: `a, b, +2 more`. */
function pathList(paths: string[]): string {
  const shown = paths.filter((p) => REASON_PATH.test(p) && !p.startsWith('-')).slice(0, 3);
  const rest = paths.length - shown.length;
  return [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ');
}

/** The CI hold's reason. Its digest covers every (path, blob), so an approval holds for exactly this content. */
export function ciHoldReason(changes: CiChange[]): string {
  const paths = changes.map((c) => c.path).sort();
  return `${PUSH_HELD_PREFIX}CI config changes: ${pathList(paths)} [ci ${digest16(changes.map((c) => `${c.path}\0${c.blob ?? ''}\0`))}]`;
}

/** The security hold's reason while the latest security verdict isn't PASS (none without a security lens). */
export function securityHoldReason(job: Pick<Job, 'verdicts'>): string | null {
  const s = latestSecurity(job);
  if (!s || s.verdict === 'PASS') return null;
  return `${PUSH_HELD_PREFIX}the security review of round ${s.round} is ${s.verdict === 'CHANGES' ? 'CHANGES' : 'not PASS'}`;
}

/** One member repo's commit scan, as the secrets hold reads it: the commit scanned, and what the scan said. */
export interface RepoScan {
  repo: string;
  head: string;
  scan: Pick<SecretScan, 'findings' | 'error'>;
}

const shortHead = (head: string): string => String(head).replace(/[^0-9a-f]/g, '').slice(0, 12);

/**
 * The secrets hold's reason under `verifySecrets: warn` (block mode refuses these before the push),
 * over the root's scan and every member's. Two parts, each present when it applies and both together
 * when both do (an approval of one must not pass the other): a scan that could not finish, bound to
 * the head (to each repo and its head when a member's too), and the findings the scans reported,
 * bound to their fingerprints (a member's together with its repo). A root-only reason has the same
 * text as ever.
 */
export function secretsHoldReason(scan: Pick<SecretScan, 'findings' | 'error'>, mode: SecretMode, head: string, members: RepoScan[] = []): string | null {
  if (mode !== 'warn') return null;
  const unfinished = members.filter((m) => m.scan.error);
  const keys = [...(scan.error ? [`\0${head}\0`] : []), ...unfinished.map((m) => `${m.repo}\0${m.head}\0`)];
  const stalled = !unfinished.length
    ? (scan.error ? `the secret scan could not finish [head ${shortHead(head)}]` : null)
    : `the secret scan could not finish in ${keys.length} ${keys.length === 1 ? 'repo' : 'repos'} [heads ${digest16(keys)}]`;
  const prints = [...new Set([...scan.findings.map((f) => `${f.fingerprint}\0`), ...members.flatMap((m) => m.scan.findings.map((f) => `${m.repo}\0${f.fingerprint}\0`))])];
  const total = scan.findings.length + members.reduce((n, m) => n + m.scan.findings.length, 0);
  const reported = total ? `the secret scan reported ${total} possible secrets [fp ${digest16(prints)}]` : null;
  const parts = [stalled, reported].filter((p): p is string => p !== null);
  return parts.length ? `${PUSH_HELD_PREFIX}${parts.join(', and ')}` : null;
}

/**
 * A person's approve (never the foreman's) given while the job was parked on `human` with exactly
 * `reason`: recallWaived's matching. The digest in the reason ties the approval to the content.
 */
export function pushHoldApproved(events: JobEvent[], reason: string): boolean {
  return events.some((e, i) => {
    if (e.type !== 'human' || e.action !== 'approve' || isForemanActor(e)) return false;
    const park = events.slice(0, i).findLast((t) => t.type === 'transition');
    const to = (park?.to ?? {}) as { state?: string; waitingOn?: string | null };
    return to.state === 'waiting' && to.waitingOn === 'human' && park?.reason === reason;
  });
}
