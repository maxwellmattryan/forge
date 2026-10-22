// Job repos: the member repos (config `repos`) one job changes beside the root repo. `job.repos[0]`
// mirrors the root's top-level fields (lib/core/job/schema.ts cleanRepos); entries 1..n are members, added
// and removed by a human (`forge job repo add|remove`), or added once by intake to the job it creates
// from a member repo's issue (lib/engine/project/member-trackers.ts). job.json is writable by the session,
// so nothing here trusts a stored clone path or worktree: the clone is recomputed from config plus
// `.forge/local.yml` every time, and a stored worktree is used only when it is the path Forge computes.

import fs from 'node:fs';
import path from 'node:path';
import { SESSION_PINS, git, pinArgs } from '../../integrations/git/runner.ts';
import { loadJob, logEvent, updateJob } from '../../core/job/store.ts';
import { memberCheck, readLocalConfig, resolveMemberPath } from './member-repos.ts';
import { exists, linkDir, resolveFrom } from '../../core/paths.ts';
import type { Config, Job, JobRepo, MemberRepoConfig } from '../../core/types.ts';
import { ForgeError } from '../../core/errors.ts';
import { assertSafeRef } from '../../core/text.ts';

/** A member entry: `repo` is always a name. */
export type MemberJobRepo = JobRepo & { repo: string };

/** The job's member repos in order (every entry after the root mirror). */
export function memberRepos(job: Pick<Job, 'repos'>): MemberJobRepo[] {
  return (Array.isArray(job.repos) ? job.repos.slice(1) : []).filter((r): r is MemberJobRepo => typeof r?.repo === 'string');
}

/** One member entry by name, or null. */
export function memberEntry(job: Pick<Job, 'repos'>, name: string): MemberJobRepo | null {
  return memberRepos(job).find((r) => r.repo === name) ?? null;
}

/** The config `repos` entry for `name`; a member the job names but config no longer lists is refused. */
export function memberConfig(config: Config, name: string): MemberRepoConfig {
  const entry = (Array.isArray(config.repos) ? config.repos : []).find((r) => r.name === name);
  if (!entry) throw new ForgeError(`repo ${JSON.stringify(name).slice(0, 110)} is not a repos entry in .forge/config.yml`);
  return entry;
}

/**
 * The member's clone directory on this machine, after doctor's member check (local.yml path, a
 * clone at its top level, the expected remote). A failing check throws its detail, which carries the fix.
 */
export function memberClone(root: string, config: Config, name: string): string {
  const repo = memberConfig(config, name);
  const local = readLocalConfig(root);
  const check = memberCheck(root, config, repo, local);
  if (!check.ok) throw new ForgeError(`repo ${name}: ${check.detail}`);
  return resolveMemberPath(root, local.repos[name].path);
}

function realpathOfExisting(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Inside or equal: a worktree at the clone itself, or under it, is never a worktree of its own. */
export function within(parent: string, child: string): boolean {
  const rel = path.relative(realpathOfExisting(parent), realpathOfExisting(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where job `id`'s worktree of member `name` goes: `worktrees.root` with `{repo}` set to the clone's
 * basename, resolved from the clone, then the job id. Outside the clone and the root repo, as the
 * root's own worktrees are (bundlers and watchers would pick up a nested copy).
 */
export function memberWorktreePath(root: string, config: Config, name: string, id: string, clone = memberClone(root, config, name)): string {
  assertSafeRef(id, 'job.id');
  const wtRoot = resolveFrom(clone, config.worktrees.root.replace('{repo}', path.basename(clone)));
  const dir = path.join(wtRoot, id);
  if (within(clone, dir)) throw new ForgeError(`repo ${name}: worktrees.root puts its worktree ${dir} inside the clone ${clone}; set worktrees.root outside it`);
  if (within(root, dir)) throw new ForgeError(`repo ${name}: worktrees.root puts its worktree ${dir} inside the root repo; set worktrees.root outside it`);
  return dir;
}

/** The member's stored worktree when it is the path Forge computes and exists, else null; never throws. */
export function trustedMemberWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'repos'>, name: string): string | null {
  const m = memberEntry(job, name);
  if (!m?.worktree) return null;
  try {
    return m.worktree === memberWorktreePath(root, config, name, job.id) && exists(m.worktree) ? m.worktree : null;
  } catch {
    return null;
  }
}

/** A member ready for a sink (run, git, verify, pr): its entry, clone and checked worktree. Throws with the fix. */
export function memberWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'repos'>, name: string): { member: MemberJobRepo; clone: string; worktree: string } {
  const member = memberEntry(job, name);
  if (!member) throw new ForgeError(`job ${job.id} has no repo ${JSON.stringify(name).slice(0, 110)}; a human adds one with: forge job repo add ${job.id} <name>`);
  const clone = memberClone(root, config, name);
  const expected = memberWorktreePath(root, config, name, job.id, clone);
  if (!member.worktree || !exists(member.worktree)) throw new ForgeError(`job ${job.id} has no worktree for repo ${name} yet; run: forge worktree create ${job.id}`);
  if (member.worktree !== expected) throw new ForgeError(`repo ${name}: the stored worktree ${JSON.stringify(member.worktree).slice(0, 120)} is not this job's worktree ${expected}`);
  // A member's base reaches git argv and command templates.
  assertSafeRef(member.base, `repos ${name} base`);
  return { member, clone, worktree: expected };
}

// Pushing to another repo is a human decision: a session misled by tracker or PR text must not widen it.
const REPO_DAEMON_REFUSAL = "forge job repo adds or removes the repos a job pushes to, which a daemon session may not change; a human runs it in their own session";

// What a consumer's PR points at decides what may be published from the job: a human choice too.
const INTERIM_DAEMON_REFUSAL = "forge job repo interim sets what a job's PRs point at and what it may publish, which a daemon session may not change; a human runs it in their own session";

/** Refuses `forge job repo interim` in a daemon session. */
export function refuseInterimInDaemon(): void {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(INTERIM_DAEMON_REFUSAL);
}

/** Refuses `forge job repo` in a daemon session. */
export function refuseJobRepoInDaemon(): void {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(REPO_DAEMON_REFUSAL);
}

/** `forge job repo add`: records a member with its defaultBranch as base, after doctor's member check. */
export function addJobRepo(root: string, config: Config, id: string, name: string, verifyOnly: boolean, opts: { downstream?: boolean } = {}): { id: string; repos: JobRepo[] } {
  const job = loadJob(root, id);
  if (['done', 'cancelled'].includes(job.state) || ['pr', 'done'].includes(job.stage))
    throw new ForgeError(`job ${id} is at stage ${job.stage} (${job.state}); repos can be added only before its PR`);
  memberConfig(config, name);
  if (memberEntry(job, name)) throw new ForgeError(`job ${id} already has repo ${name}`);
  memberClone(root, config, name);
  recordJobRepo(root, config, id, name, verifyOnly, opts);
  return { id, repos: loadJob(root, id).repos };
}

/**
 * Records member `name` on job `id` with its defaultBranch as base, and logs `job-repo-added`. The
 * caller has checked the member: `forge job repo add` for a human, and intake (startFromRef) only for
 * the job it just created from that member's own issue.
 */
export function recordJobRepo(root: string, config: Config, id: string, name: string, verifyOnly: boolean, opts: { downstream?: boolean } = {}): void {
  const entry = memberConfig(config, name);
  updateJob(root, id, (j) => {
    if (memberEntry(j, name)) throw new ForgeError(`job ${id} already has repo ${name}`);
    j.repos.push({ repo: name, worktree: null, branch: null, base: entry.defaultBranch, pr: null, verifyOnly, interim: null });
  });
  logEvent(root, id, 'job-repo-added', { repo: name, verifyOnly, ...(opts.downstream ? { downstream: true } : {}) });
}

/** git in a member checkout with the session's SESSION_PINS on top of the wrapper's, so no hook or fsmonitor program the worktree holds runs. */
function memberGit(cwd: string, args: string[], opts: { write?: boolean } = {}) {
  return git(cwd, [...pinArgs(SESSION_PINS), ...args], { allowFail: true, write: opts.write });
}

/**
 * Whether verify-only member `name` can become an edited one: its detached worktree (at the path
 * Forge computes, never the stored one) must hold no uncommitted or untracked change and no commit
 * beyond `<git.remote>/<base>` (else `<base>`), since promotion removes it. Throws with the fix.
 */
export function promoteCheck(root: string, config: Config, job: Pick<Job, 'id' | 'repos'>, name: string): void {
  const m = memberEntry(job, name);
  if (!m?.verifyOnly) throw new ForgeError(`repo ${name} is not a verify-only repo of job ${job.id}`);
  const clone = memberClone(root, config, name);
  const dir = memberWorktreePath(root, config, name, job.id, clone);
  if (!exists(dir)) return;
  const fix = `inspect it, then discard the work there or save it elsewhere (forge worktree remove ${job.id} --repo ${name} removes it), and approve again`;
  const status = memberGit(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok || status.stdout.trim()) throw new ForgeError(`repo ${name}: its verify-only worktree ${dir} has uncommitted or untracked changes, which promotion would discard; ${fix}`, 1);
  const base = assertSafeRef(m.base, `repos ${name} base`);
  const remote = assertSafeRef(config.git.remote, 'git.remote');
  const ref = memberGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${base}^{commit}`]).ok ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
  if (!memberGit(dir, ['merge-base', '--is-ancestor', 'HEAD', ref]).ok) throw new ForgeError(`repo ${name}: its verify-only worktree ${dir} has a HEAD that is not on ${ref.replace(/^refs\/(remotes|heads)\//, '')}, which promotion would discard; ${fix}`, 1);
}

/**
 * Promotes verify-only member `name` to an edited one (an approved repo proposal): removes its
 * detached worktree, clears `verifyOnly` and `worktree`, and logs `job-repo-promoted`. Step RP2 then
 * checks it out again on the job's branch. promoteCheck runs first; the caller holds the decision lock.
 */
export function promoteJobRepo(root: string, config: Config, id: string, name: string): void {
  const job = loadJob(root, id);
  promoteCheck(root, config, job, name);
  const clone = memberClone(root, config, name);
  const dir = memberWorktreePath(root, config, name, id, clone);
  if (exists(dir)) {
    const removed = memberGit(clone, ['worktree', 'remove', '--force', dir], { write: true });
    if (!removed.ok) throw new ForgeError(`repo ${name}: git worktree remove ${dir} failed: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`, 1);
  }
  memberGit(clone, ['worktree', 'prune'], { write: true });
  updateJob(root, id, (j) => {
    const e = memberEntry(j, name);
    if (!e) throw new ForgeError(`job ${id} has no repo ${name}`);
    e.verifyOnly = false;
    e.worktree = null;
  });
  logEvent(root, id, 'job-repo-promoted', { repo: name });
}

/** `forge job repo remove`: drops a member that has no PR and no worktree left. */
export function removeJobRepo(root: string, id: string, name: string): { id: string; repos: JobRepo[] } {
  const job = loadJob(root, id);
  const m = memberEntry(job, name);
  if (!m) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(name).slice(0, 110)}`);
  if (m.pr) throw new ForgeError(`repo ${name} has PR #${m.pr.number}; a repo with a PR stays on the job`);
  if (m.worktree && exists(m.worktree)) throw new ForgeError(`repo ${name} still has its worktree; run: forge worktree remove ${id} --repo ${name}`);
  updateJob(root, id, (j) => {
    j.repos = j.repos.filter((r, i) => i === 0 || r.repo !== name);
  });
  fs.rmSync(linkDir(root, id, name), { force: true, recursive: true });
  logEvent(root, id, 'job-repo-removed', { repo: name });
  return { id, repos: loadJob(root, id).repos };
}
