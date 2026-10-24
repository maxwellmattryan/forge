// `forge verify`, the gate between build and review, and verifiedHead, which asks the verify record
// whether the worktree's HEAD is verified.
import fs from 'node:fs';
import path from 'node:path';
import { ensureEnvironment, hasManagedBacking } from '../environment/lifecycle.ts';
import { enforceBudget } from '../metrics/budget.ts';
import { loadConfig, verifyGroups } from '#core/config/load.ts';
import { e2ePlan } from './e2e.ts';
import { failingLines } from './failing.ts';
import { configForJob } from '../evals/overlay.ts';
import { STATUS_ARGV, git as runGit } from '#integrations/git/runner.ts';
import { blockingLines, compactIntegrity, hiddenChanges, integrityError, renderIntegrity, testIntegrity } from '../guard/integrity.ts';
import type { CompactIntegrity, IntegrityReport } from '../guard/integrity.ts';
import { loadJob, logEvent, readEvents, updateJob, jobDir } from '#core/job/store.ts';
import { changedRepos, downstreamMembers } from '../project/downstream.ts';
import { exists } from '#core/paths.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { checkBranch, compactProtected } from '../guard/protected.ts';
import type { BranchCheck, CompactProtected } from '../guard/protected.ts';
import { logSecrets, scanBranch, secretMode, secretsOk, secretsTail, compactSecrets } from '../guard/secrets.ts';
import { refreshInterim } from '../release/interim-apply.ts';
import { resolveLinks } from '../project/links.ts';
import { memberRepos, memberWorktree, trustedMemberWorktree } from '../project/job-repos.ts';
import { commandTemplate, restoreLocks, runCommand, runCommandAsync } from '../workspace/run.ts';
import { headVerified, nextAttempt, recordRun, reportRun } from './record.ts';
import { instructionsSection, notesStep, renderSteps, restoreGroup, runGroups, verifyLockSnapshot, verifyMember } from './steps.ts';
import type { CommandRunner, MemberVerify, VerifyStep } from './steps.ts';
import type { Config, VerifyRun, VerifyRunRepo } from '#core/types.ts';
import type { CompactSecrets } from '../guard/types.ts';
import { ForgeError } from '#core/errors.ts';
import { confinedDir, writeTextAtomic } from '#core/os/fs.ts';
import { now } from '#core/utils.ts';

export type { CommandRunner };

/** The runner `forge verify` uses outside tests. */
export const COMMAND_RUNNER: CommandRunner = { sync: runCommand, async: runCommandAsync };

/** What `forge verify` returns: verify. */
export interface VerifyResult {
  ok: boolean;
  round: number;
  attempt: number;
  sha: string;
  file: string;
  steps: Omit<VerifyStep, 'tail'>[];
  failure: VerifyStep | undefined;
  integrity: CompactIntegrity | null;
  secrets: CompactSecrets;
  protected: CompactProtected;
  /** One record per member repo, only when the job has members. */
  repos?: VerifyRunRepo[];
  /** One record per downstream consumer (lib/engine/project/downstream.ts), only when the job has any. */
  downstream?: { repo: string; ok: boolean; failure: string | null }[];
  budget?: NonNullable<ReturnType<typeof enforceBudget>>;
}

/**
 * The deterministic gate between build and review: cheap commands catch what would
 * otherwise cost a full round of reviewer agents. Every run is evidence bound to the commit
 * it checked: it records the HEAD sha and keeps earlier attempts instead of overwriting them.
 * Uncommitted changes fail the gate first, because reviewers and the PR only ever see commits.
 * The secret scan (lib/engine/guard/secrets.ts) runs next, always; under `verifySecrets: block` a finding stops
 * every configured step, though the integrity report is still computed. A `verify` entry that is a list runs its steps at the same time; the next entry waits for all of
 * them, and none runs after a group with a failure. Results stay in config order whatever finishes
 * first, so `failure` is the first failing step as configured, not the first to fail.
 */
export async function verify(root: string, base: Config, id: string, runner: CommandRunner = COMMAND_RUNNER): Promise<VerifyResult> {
  // Every refusal comes before the clean check, so a config this Forge can't read records nothing:
  // guessing at it could pass a gate whose steps never ran.
  if (base.schemaVersion > CONFIG_SCHEMA_VERSION)
    throw new ForgeError(`config schemaVersion ${base.schemaVersion} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update Forge before running verify`);
  const job = loadJob(root, id);
  // An eval job's overlay picks its steps, e2e and budget; an invalid one throws here.
  const config = configForJob(root, base, job);
  const groups = verifyGroups(config.verify);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  // Every member's worktree is checked before anything runs, so a missing one records nothing.
  const checkedMembers = memberRepos(job).map((m) => memberWorktree(root, config, job, m.repo));
  // Before any HEAD is read: git-ref and canary pins, and release bumps, are committed here, so the
  // run records and checks those commits. Nothing at all for a job with only local or sequential
  // edges and no recorded release.
  const interim = refreshInterim(root, config, job);
  const members = checkedMembers.map((wt) => ({ ...wt, head: runGit(wt.worktree, ['rev-parse', 'HEAD']).stdout.trim() }));
  const sha = runGit(job.worktree, ['rev-parse', 'HEAD']).stdout.trim();
  const changed = runGit(job.worktree, [...STATUS_ARGV]).stdout.trim();
  let hiddenError: string | null = null;
  let hidden = '';
  if (!changed) {
    try {
      hidden = hiddenChanges(job.worktree, config).join('\n');
    } catch (e) {
      hiddenError = (e as Error).message;
    }
  }
  const dirty = changed || hidden;
  const results: VerifyStep[] = [];
  let integrity: IntegrityReport | null = null;
  if (dirty) results.push({ name: 'worktree-clean', ok: false, exit: null, tail: dirty });
  // Before any configured command, clean or not: a likely credential stops the round here, and the
  // staged changes are scanned too, so a key the builder has not committed yet is still reported.
  const mode = secretMode(config);
  const scanStarted = Date.now();
  // Bound to `sha`, the commit this run records as checked, not whatever HEAD is by the time the scan reads it.
  const secrets = scanBranch(root, config, job, { staged: true, head: sha });
  const secretsStep: VerifyStep = { name: 'secrets', ok: secretsOk(secrets, mode), exit: null, durationMs: Date.now() - scanStarted };
  const n = secrets.findings.length;
  if (!secretsStep.ok) secretsStep.tail = secretsTail(secrets);
  else if (secrets.error) secretsStep.reason = `scan incomplete (verifySecrets: warn): ${secrets.error}`;
  else if (n) secretsStep.reason = `${n} possible secret${n === 1 ? '' : 's'} (verifySecrets: warn)`;
  results.push(secretsStep);
  // Right after the secret scan, over the committed diff bound to `sha`: a path the policy refuses
  // stops every configured step, and one that can't be checked never reads as clean.
  const protStarted = Date.now();
  let prot: Pick<BranchCheck, 'refused' | 'escalated' | 'error'>;
  try {
    // Every repo the job pushes (not a verify-only one), over the HEAD this run records for it.
    const branches = members.filter((m) => !m.member.verifyOnly).map((m) => ({ repo: m.member.repo, worktree: m.worktree, base: m.member.base, head: m.head }));
    prot = checkBranch(root, config, job, sha, 'verify', branches);
  } catch (e) {
    prot = { refused: [], escalated: [], error: (e as Error).message };
  }
  const protectedStep: VerifyStep = { name: 'protected', ok: !prot.error && !prot.refused.length, exit: null, durationMs: Date.now() - protStarted };
  if (!protectedStep.ok) protectedStep.tail = prot.error ?? prot.refused.slice(0, 20).map((h) => `${h.path}: rule ${h.rule} (${h.glob}): ${h.reason}`).join('\n');
  else if (prot.escalated.length) protectedStep.reason = `${prot.escalated.length} protected paths need a human`;
  results.push(protectedStep);
  // Not a gate: a notes problem fails the round, but the configured commands still run.
  const notes = notesStep(root, config, job, sha);
  if (notes) results.push(notes);
  // Like protected, a pin that can't be written stops every configured step, the members' too.
  const interimStep: VerifyStep = { name: 'interim', ok: interim.ok, exit: null };
  if (!interim.ok) interimStep.tail = interim.problems.join('\n');
  else if (interim.commits.length)
    interimStep.reason = interim.commits.map((c) => `${c.kind === 'release' ? 'release bump' : 'pins'} committed in ${c.repo === null ? 'the root repo' : `repo ${c.repo}`} (${c.sha.slice(0, 12)})`).join('; ');
  if (interim.active) results.push(interimStep);
  let gatesOk = secretsStep.ok && protectedStep.ok && interimStep.ok;
  // Before any configured command, once the gates pass: a stopped per-job container starts again. A
  // failure records the step and runs no command, so no gate passes on steps that never ran.
  if (!dirty && gatesOk && hasManagedBacking(config)) {
    const envStarted = Date.now();
    const env = ensureEnvironment(root, config, job, 'verify');
    const envStep: VerifyStep = { name: 'environment', ok: env.ok, exit: null, durationMs: Date.now() - envStarted };
    if (!env.ok) envStep.tail = env.error ?? 'a backing service did not start';
    results.push(envStep);
    gatesOk = env.ok;
  }
  if (!dirty) {
    // One snapshot before the first group: steps of a group run at once, so each restores only after all settle.
    const locks = gatesOk ? verifyLockSnapshot(root, config, job, null) : null;
    try {
      const runStep = async (step: string): Promise<VerifyStep> =>
        config.commands[step] ? runner.async(root, config, id, step, { label: `verify-${step}`, lockGuard: false }) : { name: step, ok: true, skipped: true };
      results.push(...(await runGroups(gatesOk ? groups : [], runStep, (ran) => restoreGroup(root, id, null, locks, ran))));
      if (results.every((r) => r.ok)) {
        const plan = e2ePlan(config, job, commandTemplate(config, job, 'e2e'));
        if (plan?.run) {
          const e2e: VerifyStep = { ...runner.sync(root, config, id, 'e2e', { label: 'verify-e2e', lockGuard: false }), reason: plan.reason };
          restoreGroup(root, id, null, locks, [e2e]);
          results.push(e2e);
        } else if (plan) results.push({ name: 'e2e', ok: true, skipped: true, reason: plan.reason });
      }
    } finally {
      restoreLocks(root, id, null, locks);
    }
    // Computed whatever the commands returned: a deleted test is evidence even when the build is red.
    integrity = testIntegrity(root, config, job);
    if (hiddenError) integrity = integrityError(integrity, `could not check the worktree for hidden changes: ${hiddenError}`);
    if (!integrity.ok) results.push({ name: 'integrity', ok: false, exit: null, tail: blockingLines(integrity) });
  }
  // A downstream consumer proves nothing against the released library: without an active link from a
  // changed repo it fails `links` and none of its configured steps runs.
  const events = readEvents(root, id);
  const downstream = downstreamMembers(job, events);
  const changedSet = changedRepos(job, events);
  const linkGuard = (repo: string): string | null => {
    if (!downstream.has(repo)) return null;
    const mine = resolveLinks(root, config, job).filter((l) => l.consumerRepo === repo && changedSet.has(l.dependencyRepo));
    if (mine.some((l) => l.active)) return null;
    return mine.length ? mine.map((l) => `${l.ecosystem}:${l.name} from ${l.dependencyRepo ?? path.basename(root)}: ${l.reason}`).join('\n') : `no link from a changed repo to ${repo} is declared`;
  };
  // A failure in the root never skips a member, nor one member another.
  const memberRuns: MemberVerify[] = [];
  for (const m of members) memberRuns.push(await verifyMember(root, config, job, interimStep.ok ? groups : [], mode, m, linkGuard(m.member.repo), runner));
  const rootFailure = results.find((r) => !r.ok);
  const ok = results.every((r) => r.ok) && memberRuns.every((m) => m.rec.ok);
  const attempt = nextAttempt(job);
  const lines = [`VERIFY: ${ok ? 'PASS' : 'FAIL'}`, '', `Round ${job.round} · attempt ${attempt} · ${sha.slice(0, 12)} · ${now()}`, ''];
  // First, so a rework builder reads the failing tests by name before any log tail.
  lines.push(
    ...failingLines(
      [
        ...results.map((step) => ({ label: step.name, step, cwd: job.worktree! })),
        ...memberRuns.flatMap((m, i) => m.results.map((step) => ({ label: `${m.rec.repo}:${step.name}`, step, cwd: members[i].worktree }))),
      ],
      jobDir(root, id),
    ),
  );
  const brokenDownstream = memberRuns.filter((m) => !m.rec.ok && downstream.has(m.rec.repo));
  for (const m of brokenDownstream)
    lines.push(`Downstream consumer \`${m.rec.repo}\` failed \`${m.rec.failure}\`: fix the library on this job, or propose changing the consumer: forge job repo propose ${id} ${m.rec.repo} --reason "…"`);
  if (brokenDownstream.length) lines.push('');
  renderSteps(lines, results, secrets, mode, prot);
  // A record for the approver, never a gate: computed after `ok`, so it can't change the run.
  lines.push(instructionsSection(config, job, sha));
  if (integrity) lines.push(renderIntegrity(integrity));
  for (const m of memberRuns) {
    lines.push('', `# ${downstream.has(m.rec.repo) ? 'Downstream consumer' : 'Repo'} ${m.rec.repo} · ${m.rec.sha.slice(0, 12)}`, '');
    renderSteps(lines, m.results, m.secrets, mode, null, downstream.has(m.rec.repo));
    if (m.integrity) lines.push(renderIntegrity(m.integrity));
  }
  // Only through real directories: a link or file planted at verify/ fails here, before any write.
  const dir = path.join(jobDir(root, id), 'verify');
  confinedDir(jobDir(root, id), dir);
  const latest = path.join(dir, `round-${job.round}.md`);
  // round-<n>.md is the last report verify wrote; a verifiers failure appends a run with its own file.
  const previous = reportRun(job);
  if (previous && exists(latest)) fs.renameSync(latest, path.join(dir, `round-${job.round}-attempt-${previous.attempt}.md`));
  writeTextAtomic(latest, lines.join('\n'), { root: jobDir(root, id) });
  const memberFailure = memberRuns.find((m) => !m.rec.ok);
  const repos = memberRuns.length ? { repos: memberRuns.map((m) => m.rec) } : {};
  const rec: VerifyRun = { round: job.round, attempt, sha, ok, at: now(), file: path.relative(jobDir(root, id), latest), failure: rootFailure?.name ?? memberFailure?.rec.failure ?? null, ...repos };
  // Every failure, a dirty worktree included, asks for one retry; a pass does not reset it.
  updateJob(root, id, (j) => recordRun(j, rec));
  logEvent(root, id, 'verify', rec);
  logSecrets(root, id, 'verify', secrets, { blocked: mode === 'block', round: job.round });
  for (const m of memberRuns) logSecrets(root, id, 'verify', m.secrets, { blocked: mode === 'block', round: job.round });
  // enforceBudget applies the job's overlay itself.
  const budget = enforceBudget(root, base, id, 'verify');
  return {
    ok,
    round: job.round,
    attempt,
    sha,
    file: path.relative(root, latest),
    steps: results.map(({ tail: _t, ...r }) => r),
    failure: rootFailure ?? memberFailure?.results.find((r) => !r.ok),
    integrity: integrity ? compactIntegrity(integrity) : null,
    secrets: compactSecrets(secrets, mode),
    protected: compactProtected(prot),
    ...repos,
    ...(downstream.size ? { downstream: memberRuns.filter((m) => downstream.has(m.rec.repo)).map((m) => ({ repo: m.rec.repo, ok: m.rec.ok, failure: m.rec.failure })) } : {}),
    ...(budget ? { budget } : {}),
  };
}

/**
 * Whether the worktree's HEAD is verified (lib/engine/verify/record.ts headVerified): this round's
 * last verify run passed on it and on every member HEAD. Anything that publishes a branch should
 * refuse when it is not: evidence for an older commit, or from before this round's review, is not evidence.
 */
export function verifiedHead(root: string, id: string): { head: string; last: VerifyRun | null; verified: boolean; heads?: Record<string, string> } {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const head = runGit(job.worktree, ['rev-parse', 'HEAD']).stdout.trim();
  const members = memberRepos(job);
  if (!members.length) return { head, ...headVerified(job, { root: head }) };
  // A member without its trusted worktree has no HEAD here, so the record reads it as not verified.
  const config = loadConfig(root).config;
  const heads: Record<string, string> = {};
  for (const m of members) {
    const wt = trustedMemberWorktree(root, config, job, m.repo);
    if (wt) heads[m.repo] = runGit(wt, ['rev-parse', 'HEAD']).stdout.trim();
  }
  return { head, ...headVerified(job, { root: head, repos: heads }), heads };
}
