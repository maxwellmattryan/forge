// Verify's steps beside the root's run: the notes step, a member repo's checks, the lockfile
// snapshot and restore around a group, and the report's step sections. gate.ts imports this module.
import { committedChanges, resolveBase } from '../pipeline/scope.ts';
import { checkNotes, checkedNotes } from '../evals/experiments.ts';
import { STATUS_ARGV, git as runGit, historyEnv } from '#integrations/git/runner.ts';
import { blockingLines, hiddenChanges, integrityError, testIntegrity } from '../guard/integrity.ts';
import type { IntegrityReport } from '../guard/integrity.ts';
import { renderProtected } from '../guard/protected.ts';
import type { BranchCheck } from '../guard/protected.ts';
import { renderSecrets, scanBranch, secretMode, secretsOk, secretsTail } from '../guard/secrets.ts';
import { consumerLockfiles, snapshotLockfiles } from '../project/links.ts';
import type { LockSnapshot } from '../project/links.ts';
import { memberComponent, restoreLocks } from '../workspace/run.ts';
import type { CommandResult, RunOptions } from '../workspace/run.ts';
import type { Config, Job, JobRepo, VerifyRunRepo } from '#core/types.ts';
import type { SecretScan } from '../guard/types.ts';
import { ForgeError } from '#core/errors.ts';

/** One verify step: a command's result, a skipped step, or a gate verify adds itself (worktree-clean, secrets, protected, integrity). */
export interface VerifyStep {
  name: string;
  ok: boolean;
  exit?: number | null;
  tail?: string;
  skipped?: boolean;
  reason?: string;
  cmd?: string;
  log?: string;
  durationMs?: number;
  links?: string[];
  restored?: string[];
}

/** How verify runs a configured command: `runCommand` and `runCommandAsync` in production, a stub in tests. */
export interface CommandRunner {
  sync: (root: string, config: Config, id: string, name: string, opts?: RunOptions) => CommandResult;
  async: (root: string, config: Config, id: string, name: string, opts?: RunOptions) => Promise<CommandResult>;
}

/**
 * Runs verify's groups in config order: a group's steps run at once, and the next group waits for
 * all of them. A failing step never stops its siblings: each finishes and keeps its own log. One that
 * throws is reported only once the others have settled, so none writes after verify returns, and its
 * group's `afterGroup` is not called. Results stay in config order whatever finishes first, and no
 * group starts after one with a failure.
 */
export async function runGroups(groups: string[][], runStep: (step: string) => Promise<VerifyStep>, afterGroup: (ran: VerifyStep[]) => void): Promise<VerifyStep[]> {
  const results: VerifyStep[] = [];
  for (const group of groups) {
    // async: a step that throws before its promise exists still lets its siblings run.
    const settled = await Promise.allSettled(group.map(async (step) => runStep(step)));
    const thrown = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (thrown) throw thrown.reason;
    const ran = settled.map((s) => (s as PromiseFulfilledResult<VerifyStep>).value);
    afterGroup(ran);
    results.push(...ran);
    if (ran.some((r) => !r.ok)) break;
  }
  return results;
}

/** Verify's snapshot of one consumer repo's lockfiles, taken before its first group. */
export function verifyLockSnapshot(root: string, config: Config, job: Job, repo: string | null): LockSnapshot | null {
  const c = consumerLockfiles(root, config, job, repo);
  return c ? snapshotLockfiles(c.worktree, c.ecosystems) : null;
}

/** Restores after a verify group settles and records what it restored on that group's steps. */
export function restoreGroup(root: string, id: string, repo: string | null, snap: LockSnapshot | null, ran: VerifyStep[]): void {
  const restored = restoreLocks(root, id, repo, snap);
  if (restored.length) for (const r of ran) if (!r.skipped) r.restored = restored;
}

/**
 * The `notes` step: when the committed diff (merge base..`sha`) touches a learnings, ledger or
 * addendum file, `forge experiment check` over the committed content at `sha`, never the working
 * tree; absent when no notes file changed. Without a merge base, a notes file at `sha` that differs
 * from the main checkout's HEAD may hold a hand-written status, so the step fails; when none differs
 * there is nothing to check. A check that fails once it applies fails the step.
 */
export function notesStep(root: string, config: Config, job: Job, sha: string): VerifyStep | null {
  const started = Date.now();
  const wt = job.worktree!;
  const failed = (tail: string): VerifyStep => ({ name: 'notes', ok: false, exit: null, durationMs: Date.now() - started, tail });
  let changed: Set<string>;
  try {
    changed = new Set(committedChanges(wt, resolveBase(wt, config, job, sha).mergeBase, sha));
  } catch (e) {
    let differs: string[];
    try {
      const main = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { env: historyEnv() }).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(main)) throw new ForgeError('the main checkout has no HEAD commit');
      const touched = new Set(committedChanges(wt, main, sha));
      differs = checkedNotes().filter((f) => touched.has(f));
    } catch {
      differs = ['the notes files'];
    }
    if (!differs.length) return null;
    return failed(`could not resolve the base (${(e as Error).message.slice(0, 200)}), and ${differs.join(', ')} differ from the main checkout's HEAD`);
  }
  if (!checkedNotes().some((f) => changed.has(f))) return null;
  try {
    const r = checkNotes(root, config, job, sha);
    const step: VerifyStep = { name: 'notes', ok: r.ok, exit: null, durationMs: Date.now() - started };
    if (!r.ok) step.tail = r.problems.slice(0, 20).map((p) => `${p.file}: ${p.problem}${p.entry ? ` (${p.entry})` : ''}`).join('\n');
    return step;
  } catch (e) {
    return failed(`could not check the notes layer: ${(e as Error).message}`);
  }
}

/** One member repo's verify: its record, its steps for the report, and its scan and integrity report. */
export interface MemberVerify {
  rec: VerifyRunRepo;
  results: VerifyStep[];
  secrets: SecretScan;
  integrity: IntegrityReport | null;
}

/**
 * A member repo's checks, in the root's order: worktree-clean, the secret scan over its range, each
 * `verify` group step as the member component's command (skipped when none defines it), then test
 * integrity against the member's base. No e2e or verifiers step: those are root-only. Its protected
 * paths are checked in the root's `protected` step, named `<repo>:<path>`.
 */
export async function verifyMember(
  root: string,
  config: Config,
  job: Job,
  groups: string[][],
  mode: ReturnType<typeof secretMode>,
  m: { member: JobRepo & { repo: string }; worktree: string; head: string },
  inactiveLinks: string | null,
  runner: CommandRunner,
): Promise<MemberVerify> {
  const repo = m.member.repo;
  const cwd = m.worktree;
  // The view scanBranch and testIntegrity read: the member's worktree and base under the job's id.
  const view = { id: job.id, worktree: cwd, base: m.member.base };
  // The HEAD the root's protected check saw, so the run records the commit it checked.
  const sha = m.head;
  const changed = runGit(cwd, [...STATUS_ARGV]).stdout.trim();
  let hiddenError: string | null = null;
  let hidden = '';
  if (!changed) {
    try {
      hidden = hiddenChanges(cwd, config).join('\n');
    } catch (e) {
      hiddenError = (e as Error).message;
    }
  }
  const dirty = changed || hidden;
  const results: VerifyStep[] = [];
  if (dirty) results.push({ name: 'worktree-clean', ok: false, exit: null, tail: dirty });
  const scanStarted = Date.now();
  const secrets = scanBranch(root, config, view, { staged: true, head: sha });
  const secretsStep: VerifyStep = { name: 'secrets', ok: secretsOk(secrets, mode), exit: null, durationMs: Date.now() - scanStarted };
  const n = secrets.findings.length;
  if (!secretsStep.ok) secretsStep.tail = secretsTail(secrets);
  else if (secrets.error) secretsStep.reason = `scan incomplete (verifySecrets: warn): ${secrets.error}`;
  else if (n) secretsStep.reason = `${n} possible secret${n === 1 ? '' : 's'} (verifySecrets: warn)`;
  results.push(secretsStep);
  if (inactiveLinks !== null) results.push({ name: 'links', ok: false, exit: null, tail: inactiveLinks });
  const runSteps = secretsStep.ok && inactiveLinks === null;
  let integrity: IntegrityReport | null = null;
  if (!dirty) {
    const locks = runSteps ? verifyLockSnapshot(root, config, job, repo) : null;
    try {
      const runStep = async (step: string): Promise<VerifyStep> =>
        memberComponent(config, repo, step)
          ? runner.async(root, config, job.id, step, { label: `verify-${repo}-${step}`, repo, lockGuard: false })
          : { name: step, ok: true, skipped: true, reason: `no ${step} command for repo ${repo}` };
      results.push(...(await runGroups(runSteps ? groups : [], runStep, (ran) => restoreGroup(root, job.id, repo, locks, ran))));
    } finally {
      restoreLocks(root, job.id, repo, locks);
    }
    integrity = testIntegrity(root, config, view);
    if (hiddenError) integrity = integrityError(integrity, `could not check the worktree for hidden changes: ${hiddenError}`);
    if (!integrity.ok) results.push({ name: 'integrity', ok: false, exit: null, tail: blockingLines(integrity) });
  }
  const failed = results.find((r) => !r.ok);
  return { rec: { repo, sha, ok: !failed, failure: failed?.name ?? null }, results, secrets, integrity };
}

/** The `## <step>: …` sections of a verify report, the root's (with `prot`) and each member's alike. */
// `linkGuard`: only a downstream consumer's results can hold the link guard, so a root or member
// step a repo happens to name `links` renders like any other configured step.
export function renderSteps(lines: string[], results: VerifyStep[], secrets: SecretScan, mode: ReturnType<typeof secretMode>, prot: Pick<BranchCheck, 'refused' | 'escalated' | 'error'> | null, linkGuard = false): void {
  for (const r of results) {
    if (r.name === 'worktree-clean') {
      lines.push('## worktree-clean: FAILED (uncommitted or hidden changes)', '', 'Commit or discard these (or clear the index flags and filters) before verify can run:', '', '```', r.tail!, '```', ''); // the gate's tail lists the changes
      continue;
    }
    if (r.name === 'integrity') continue;
    if (r.name === 'secrets') {
      lines.push(renderSecrets(secrets, mode));
      continue;
    }
    if (r.name === 'protected' && prot) {
      lines.push(renderProtected(prot));
      continue;
    }
    if (linkGuard && r.name === 'links' && !r.ok) {
      lines.push('## links: FAILED', '', 'No link from a changed repo is active for this downstream consumer, so its tests would build against the released library; no configured step ran:', '', ...String(r.tail).split('\n').map((l) => `- ${l}`), '');
      continue;
    }
    if (r.name === 'environment' && !('cmd' in r)) {
      if (r.ok) lines.push('## environment: ok', '', "The job's backing services are up.", '');
      else lines.push('## environment: FAILED', '', "The job's backing services did not start (docs/CONFIG.md \"Backing services\"); no configured step ran:", '', '```', String(r.tail), '```', '');
      continue;
    }
    if (r.name === 'notes' && !('cmd' in r)) {
      if (r.ok) lines.push('## notes: ok', '', 'Every changed notes entry is measurable, and only `forge experiment evaluate` settled a ledger entry.', '');
      else lines.push('## notes: FAILED', '', 'The notes layer (docs/IMPROVEMENT.md "The notes check") refuses these entries; the configured steps still ran:', '', ...String(r.tail).split('\n').map((l) => `- ${l}`), '');
      continue;
    }
    if (r.name === 'interim') {
      if (r.ok) lines.push('## interim: ok', '', r.reason ?? 'Every git-ref and canary pin, and every release bump, is current.', '');
      else lines.push('## interim: FAILED', '', 'Interim pins or release bumps (docs/CONFIG.md "Interim strategies") could not be written; no configured step ran:', '', ...String(r.tail).split('\n').map((l) => `- ${l}`), '');
      continue;
    }
    lines.push(`## ${r.name}: ${r.skipped ? `skipped (${r.reason ?? 'no command configured'})` : r.ok ? 'ok' : `FAILED (exit ${r.exit})`}`);
    if ('cmd' in r) lines.push('', '`' + r.cmd + '` · log: `' + r.log + '`');
    if (r.reason && !r.skipped) lines.push('', `Trigger: ${r.reason}`);
    if ('tail' in r && !r.ok) lines.push('', '```', r.tail!, '```'); // 'tail' in r: the step has one
    lines.push('');
  }
}
