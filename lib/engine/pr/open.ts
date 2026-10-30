// Opening a job's PRs: the checks before anything leaves the machine (the held push among them),
// interim deferrals and drafts, the pushes and the PRs, the gate section and label `forge pr gate`
// syncs while the merge waits on a person, and retargeting a stacked PR.
import path from 'node:path';
import { jobDir, loadJob, logEvent, readEvents, setJob } from '#core/job/store.ts';
import { writeAtomic } from '#core/os/fs.ts';
import { prLinkNote } from '#core/job/issue-link.ts';
import type { Config, GateReason, Job, JobRepoPr } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import { safeText } from '#core/text.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { assertJobPr, safePrNumber } from '#integrations/github/pull-requests.ts';
import type { GitHub } from '#integrations/github/types.ts';
import { queueNotify } from '#office/notify.ts';
import { memberEntry, memberRepos } from '../project/job-repos.ts';
import { unpromotedDownstream } from '../project/downstream.ts';
import { jobRepoOrder } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { LIST_LIMIT, checkBranch, logEscalated, protectedApproved, refusalText } from '../guard/protected.ts';
import type { BranchCheck, MemberBranch } from '../guard/protected.ts';
import { ciHoldReason, isCiHit, pushCiChanges, pushHoldApproved, secretsHoldReason, securityHoldReason } from '../guard/push-hold.ts';
import type { CiChange } from '../guard/push-hold.ts';
import { attributionForbidden, scrubBranch } from '../guard/attribution.ts';
import { logSecrets, refusalMessage, refuseSecrets, scanBranch, secretMode, secretsBlock, textUnit } from '../guard/secrets.ts';
import type { SecretMode } from '../guard/secrets.ts';
import type { SecretScan } from '../guard/types.ts';
import { verifiedHead } from '../verify/gate.ts';
import { FULL_SHA, heldConsumers, releaseGates, repoLabel, resolveInterim } from '../release/interim.ts';
import type { Deferral } from '../release/interim.ts';
import { interimStatus } from '../release/interim-apply.ts';
import { findPr } from './adopt.ts';
import { GATE_END, GATE_START, gateSection, prText, spliceSection } from './body.ts';
import { loadStepInput } from '../pipeline/step/input.ts';
import { computeFacts } from '../pipeline/step/facts.ts';
import { mergeGate } from '../pipeline/step/stages/pr.ts';
import type { MergeGate } from '../pipeline/step/stages/pr.ts';
import { pullPrHead, pushBranch, refreshBase } from './branch.ts';
import { checkMemberPr, linkSiblingsQuietly, memberSlug, openMemberPr, recordMemberPr } from './members.ts';
import type { MemberPrPlan, MemberPrResult } from './members.ts';
import { requiredChecksNote } from './required.ts';

export function openPr(
  root: string,
  config: Config,
  github: GitHub,
  id: string,
  opts: { title?: string; draft?: boolean; force?: boolean } = {},
): { number: number | null; url: string | null; created: boolean; unlinked?: true; repos?: MemberPrResult[]; deferred?: Deferral[]; requiredChecksWarning?: string } {
  const job = loadJob(root, id);
  // job.json is session-writable: a downstream consumer becomes a pushed repo only through a promotion event.
  const unpromoted = unpromotedDownstream(job, readEvents(root, id));
  if (unpromoted.length) throw new ForgeError(`repo ${unpromoted.join(', ')} joined job ${id} as a downstream consumer and was never promoted, so forge pr open won't push it; propose it (forge job repo propose ${id} <repo> --reason "…") for a human to approve`);
  github.require();
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree`);
  // A PR branch moved on GitHub (an "Update branch", a person's push) would reject the push as
  // non-fast-forward. Merge it in rather than force over it, and send the job back through verify for
  // the merged HEAD: step PR2b re-verifies after a pr-head-pulled event.
  const pulled = pullPrHead(root, config, job);
  if (pulled?.pulled === 'conflicts')
    throw new ForgeError(`PR branch ${job.branch} moved on ${config.git.remote} (${pulled.head.slice(0, 12)}) and conflicts with ${id}'s HEAD; the merge was aborted, so resolve it in the worktree and run forge verify ${id}`, 'failed');
  if (pulled && pulled.pulled !== 'none')
    throw new ForgeError(`PR branch ${job.branch} moved on ${config.git.remote}: merged ${pulled.head.slice(0, 12)} into the worktree (${pulled.pulled}); verify the merged HEAD, then open again`, 'failed', `forge verify ${id}`);
  // Checked before the attribution scrub, which rewrites shas: the question is whether the
  // commits as the builder left them were verified.
  const evidence = verifiedHead(root, id);
  if (!evidence.verified) {
    const last = evidence.last ? `last verify: round ${evidence.last.round} attempt ${evidence.last.attempt}, ${evidence.last.ok ? 'PASS' : 'FAIL'} on ${String(evidence.last.sha).slice(0, 12)}` : `no verify run in round ${Number(job.round)}`;
    // With job repos the root HEAD can match while a member's does not: name what moved.
    const repoNote = evidence.heads && evidence.last?.ok && evidence.last.sha === evidence.head ? `, but a job repo HEAD is not the one it checked` : '';
    if (!opts.force) throw new ForgeError(`HEAD ${evidence.head.slice(0, 12)} of ${id} is not verified (${last}${repoNote}); run: forge verify ${id}, or pass --force`);
    logEvent(root, id, 'pr-unverified', { head: evidence.head, last: evidence.last });
  }
  // Before any gh call or push, and even for a PR that already exists: the scan is the last point
  // where nothing has left the machine yet.
  const text = prText(root, config, job, opts.title);
  refuseSecrets(root, config, [textUnit('(pr title)', text.title), textUnit('(pr body)', text.body)], { what: 'the PR title or body', id, gate: 'pr' });
  // The commits are scanned here too, verified or not: this is the real exit, a HEAD verified by a
  // Forge without the scanner was never scanned, and --force skips verify altogether.
  const mode = secretMode(config);
  const fresh = refreshBase(job, config, mode);
  const scan = scanBranch(root, config, job, { staged: false, head: evidence.head });
  logSecrets(root, id, 'pr', scan, { blocked: mode === 'block' });
  if (mode === 'block' && scan.error) throw new ForgeError(`secret scan of ${id}'s commits could not finish (${scan.error}); forge pr open won't push an unscanned branch`, 'secret_found', `forge secrets scan ${id}`);
  if (secretsBlock(scan.findings, mode)) throw new ForgeError(refusalMessage(`the commits of ${id}`, scan.findings), 'secret_found', `forge secrets scan ${id}`);
  // With interim edges, a member whose PR already merged (a sequential dependency, say) is never
  // pushed or checked again. Other jobs keep checking every member, as before interim strategies.
  const skipMerged = resolveInterim(config, job).edges.length > 0;
  const open = memberRepos(job).filter((m) => !m.verifyOnly && !(skipMerged && m.pr?.state === 'MERGED'));
  // Every member is checked before anything is pushed, then opened before the root PR, so a member
  // failure leaves no root PR behind.
  const plans = open.map((m) => checkMemberPr(root, config, job, m.repo, text.title, mode, evidence.heads?.[m.repo]));
  // After checkMemberPr, which refreshes each member's base from its push remote and pushes nothing:
  // a member's remote-tracking base is writable from its worktree, and checked stale it would hide
  // the member's protected paths behind an empty diff, as the root's refresh above prevents for it.
  const check = refuseProtected(root, config, job, evidence.head, plans.map((p) => ({ repo: p.repo, worktree: p.worktree, base: p.base, head: p.checked })));
  // Still before any push in any repo, and --force doesn't skip it: the held push.
  refusePushHold(root, config, job, evidence.head, plans, { scan, mode, fresh }, check);
  // From here on only the checked commit is used, never HEAD: a commit made in the worktree after
  // the checks (a stale session, a process the builder left behind) must not ride along.
  const checked = evidence.head;
  if (!FULL_SHA.test(checked)) throw new ForgeError(`HEAD of ${id} is not a commit id`);
  const slug = github.repoSlug(root, config);
  const ahead = git(job.worktree!, ['rev-list', '--count', `${config.git.remote}/${job.base}..${checked}`, '--'], { allowFail: true });
  if (ahead.ok && ahead.stdout.trim() === '0') throw new ForgeError(`branch ${job.branch} has no commits ahead of ${job.base}`);
  // Interim strategies, judged against the checked commits before anything is pushed.
  // A merged member is not re-checked, but a consumer may still pin it: its HEAD now stands in.
  const heads = new Map<RepoKey, string>([[null, checked], ...Object.entries(evidence.heads ?? {}), ...plans.map((p): [RepoKey, string] => [p.repo, p.checked])]);
  const interim = interimOpenPlan(root, config, github, job, heads);
  const isDeferred = (k: RepoKey) => interim.deferred.some((d) => d.repo === k);
  plans.sort((a, b) => interim.order.indexOf(a.repo) - interim.order.indexOf(b.repo));
  let rootPushed: string | null = null;
  const pushRoot = (): string => {
    if (rootPushed !== null) return rootPushed;
    let pushedSha = checked;
    let rewritten = false;
    if (attributionForbidden(config)) {
      const remoteBase = `${config.git.remote}/${job.base}`;
      // createJob always sets base and branch; so below.
      const base = git(job.worktree!, ['rev-parse', '--verify', '--quiet', remoteBase], { allowFail: true }).ok ? remoteBase : job.base!;
      // Rewrites messages only, from the checked commit: every tree stays the one that was checked.
      const scrub = scrubBranch(job.worktree!, base, checked, historyEnv());
      if (scrub.rewritten) {
        rewritten = true;
        pushedSha = scrub.sha;
        logEvent(root, id, 'attribution-scrubbed', { rewritten: scrub.rewritten, commits: scrub.commits });
      }
    }
    // The exact sha GitHub gets, so the merge-time head pin compares against what was checked.
    pushBranch(job, config, pushedSha, { force: rewritten });
    rootPushed = pushedSha;
    return pushedSha;
  };
  const rootMerged = job.pr?.state === 'MERGED';
  // A consumer pins the root's sha (git-ref), so the root's branch exists before any member's.
  if (interim.rootFirst && !rootMerged && !isDeferred(null)) pushRoot();
  const memberResults = plans.filter((p) => !isDeferred(p.repo)).map((p) => openMemberPr(root, config, github, job, p, text.title, interim.drafts.has(p.repo) ? true : opts.draft));
  const repos = memberRepos(job).length ? { repos: memberResults } : {};
  const deferred = interim.deferred.length ? { deferred: interim.deferred } : {};
  const logDeferred = () => {
    if (interim.deferred.length) logEvent(root, id, 'pr-deferred', { deferred: interim.deferred });
  };
  if (isDeferred(null) || rootMerged) {
    logDeferred();
    linkSiblingsQuietly(root, config, github, id);
    const pr = rootMerged ? { number: job.pr!.number, url: job.pr!.url } : { number: null, url: null };
    return { ...pr, created: false, ...prLinkNote(job, config), ...repos, ...deferred };
  }
  const pushedSha = pushRoot();
  const existing = findPr(root, config, github, id);
  if (existing && existing.state === 'OPEN') {
    setJob(root, id, { owned: { 'pr.pushedSha': pushedSha } });
    logEvent(root, id, 'pr-updated', { number: existing.number });
    logDeferred();
    linkSiblingsQuietly(root, config, github, id);
    return { number: existing.number, url: existing.url, created: false, ...prLinkNote(job, config), ...repos, ...deferred, ...requiredChecksNote(config, github, job.worktree!, slug, job.base!) };
  }
  const bodyFile = path.join(jobDir(root, id), 'pr-body.md');
  writeAtomic(bodyFile, text.body);
  // A consumer on a local edge has nothing CI can resolve, and one on a sequential edge waits for the
  // dependency's release: its PR is held as a draft.
  const isDraft = interim.drafts.has(null) || Boolean(opts.draft ?? config.pr.draft);
  const { number, url } = github.create(job.worktree!, { slug, base: job.base!, head: job.branch!, title: text.title, bodyFile, draft: isDraft, labels: config.pr.labels ?? [], reviewers: config.pr.reviewers ?? [] });
  if (number === null) throw new ForgeError(`gh pr create printed no PR url for ${slug}`);
  setJob(root, id, { owned: { pr: { number, url, state: 'OPEN', isDraft, openedAt: now(), lastSyncedAt: now(), pushedSha } } });
  logEvent(root, id, 'pr-opened', { number, url });
  logDeferred();
  queueNotify(root, ['pr-opened'], { job: job.id, reason: 'pr-opened' });
  linkSiblingsQuietly(root, config, github, id);
  return { number, url, created: true, ...prLinkNote(job, config), ...repos, ...deferred, ...requiredChecksNote(config, github, job.worktree!, slug, job.base!) };
}

/** What interim strategies make of one `pr open`: interimOpenPlan. */
interface InterimOpenPlan {
  /** The job's PR repos, dependencies first: members open in this order. */
  order: RepoKey[];
  deferred: Deferral[];
  /** Consumers on a local edge, and on a sequential edge whose release is unrecorded: their PR is created as a draft. */
  drafts: Set<RepoKey>;
  /** The root is the dependency of a git-ref or canary edge: its branch is pushed before any member's. */
  rootFirst: boolean;
}

/**
 * Refuses a `blocked` edge, and a git-ref or canary pin that is stale against the checked commits
 * (`interim_stale`), then works out which repos wait: a sequential consumer until its dependency's
 * PR merged (asked of GitHub now), a canary consumer until the version is published, and every repo
 * that depends on a waiting one through a sequential, git-ref or canary edge.
 */
function interimOpenPlan(root: string, config: Config, github: GitHub, job: Job, heads: Map<RepoKey, string>): InterimOpenPlan {
  const { edges } = interimStatus(root, config, job, heads);
  const { order } = jobRepoOrder(config, job);
  const blocked = edges.find((e) => e.state === 'blocked');
  if (blocked) throw new ForgeError(`interim ${blocked.strategy}: ${repoLabel(blocked.consumer)} on ${repoLabel(blocked.dependency)} can't be pinned: ${blocked.detail}`);
  const stale = edges.find((e) => e.state === 'stale');
  if (stale)
    throw new ForgeError(
      `interim ${stale.strategy}: ${stale.detail.replace(/; run: .*$/, '')}; the checked commits don't ${stale.release ? 'name the released version' : 'carry the pin'}`,
      'interim_stale',
      `forge verify ${job.id}`,
    );
  const merged = new Map<RepoKey, boolean>();
  const isMerged = (k: RepoKey): boolean => {
    if (!merged.has(k)) merged.set(k, freshMerged(root, config, github, job, k));
    return merged.get(k)!;
  };
  const deferred: Deferral[] = [];
  for (const repo of order) {
    const mine = edges.filter((e) => e.consumer === repo);
    let d: Deferral | null = null;
    const waiting = mine.find((e) => e.strategy === 'sequential' && !isMerged(e.dependency));
    if (waiting) d = { repo, why: 'sequential', waitingOn: mine.filter((e) => e.strategy === 'sequential' && !isMerged(e.dependency)).map((e) => e.dependency) };
    const canary = !d && mine.find((e) => e.strategy === 'canary' && e.state === 'waiting');
    if (canary && canary.canary) d = { repo, why: 'canary', waitingOn: [canary.dependency], version: canary.canary.version, name: canary.canary.name };
    // A repo built on a waiting one through a pin or a merge order waits for the same thing.
    const via = !d && mine.find((e) => e.strategy !== 'local' && deferred.some((x) => x.repo === e.dependency));
    if (via) d = { ...deferred.find((x) => x.repo === via.dependency)!, repo };
    if (d) deferred.push(d);
  }
  const held = heldConsumers(releaseGates(edges, readEvents(root, job.id), job));
  const drafts = new Set(edges.filter((e) => e.strategy === 'local' || (e.strategy === 'sequential' && held.has(e.consumer))).map((e) => e.consumer));
  const rootFirst = edges.some((e) => e.dependency === null && (e.strategy === 'git-ref' || e.strategy === 'canary'));
  return { order, deferred, drafts, rootFirst };
}

/**
 * Whether a job repo's PR is MERGED according to GitHub now (a recorded state is writable). No PR
 * counts as not merged; so does one that is not the job's own, or any gh failure. When the record
 * says MERGED and GitHub disagrees, GitHub wins and the record is corrected (`pr-state-corrected`):
 * otherwise step would see a merged dependency, run pr open (PR7), and pr open would defer again,
 * forever. A record GitHub can't confirm either way stops pr open instead.
 */
function freshMerged(root: string, config: Config, github: GitHub, job: Job, key: RepoKey): boolean {
  const pr = key === null ? job.pr : memberEntry(job, key)?.pr;
  const number = safePrNumber(pr?.number);
  if (number === null) return false;
  let live: PrStateKey = null;
  try {
    const slug = key === null ? github.repoSlug(root, config) : memberSlug(config, key);
    const view = github.view(root, slug, number);
    assertJobPr(view, job.branch, key === null ? job.base : (memberEntry(job, key)?.base ?? null), `PR #${number} in ${slug}`);
    live = view.state;
  } catch {}
  if (pr?.state === 'MERGED' && live !== 'MERGED') {
    if (live === null) throw new ForgeError(`${repoLabel(key)}'s PR #${number} is recorded MERGED, but GitHub can't confirm its state; run: forge pr sync ${job.id}`, 'external');
    if (key === null) setJob(root, job.id, { owned: { 'pr.state': live } });
    else recordMemberPr(root, job.id, key, (prev) => ({ ...(prev ?? {}), state: live }) as JobRepoPr);
    logEvent(root, job.id, 'pr-state-corrected', { repo: key, number, recorded: 'MERGED', live });
  }
  return live === 'MERGED';
}

/**
 * The protected-paths re-check before anything leaves the machine, `--force` or not. The set is
 * recomputed from the branch (a hand-cleared job.json flag changes nothing) and a refuse path stops
 * the open. An escalate CI path stops it until a human approved its current content at the escalation
 * park before the push (PP1): pushing it runs it. Other escalate paths are pushed and logged, and wait
 * for the approval on the escalation park before merge (PR15).
 */
function refuseProtected(root: string, config: Config, job: Job, head: string, members: MemberBranch[]): BranchCheck {
  const id = job.id;
  const c = checkBranch(root, config, job, head, 'pr', members);
  if (c.error) throw new ForgeError(`can't check ${id}'s protected paths (${c.error}); forge pr open won't push a branch it can't check`, 'protected_path');
  if (c.refused.length) throw new ForgeError(refusalText('forge pr open', c.refused), 'protected_path');
  if (c.escalated.length && !protectedApproved(c.flag, readEvents(root, id))) {
    const ci = c.escalated.filter((h) => isCiHit(h.path));
    logEscalated(root, id, 'pr', c.escalated, head, ci.length > 0);
    if (ci.length) throw new ForgeError(`protected CI paths need a human approval before the push: ${ci.length} paths; /forge approve ${id}`, 'protected_path');
  }
  return c;
}

/**
 * The held push (lib/engine/guard/push-hold.ts), after the protected-paths check and before any push,
 * member push or create: the latest security verdict, the secrets the scan only reported, then every
 * repo's CI changes since what Forge last pushed. CI paths a person approved as protected paths at
 * this content are not held twice. The first hold no person approved at its exact reason is logged
 * (`push-held`, which step's PR13 parks on) and refused. The secrets hold reads every repo's commit
 * scan (`scanned` is the root's, each member's rides on its plan). A repo whose base could not be
 * re-read from the push remote (`fresh`, only possible under `warn`) has a CI diff that can't be
 * trusted, since the remote-tracking ref it reads is writable from the worktree: that refuses the push.
 */
function refusePushHold(root: string, config: Config, job: Job, head: string, plans: MemberPrPlan[], scanned: { scan: SecretScan; mode: SecretMode; fresh: boolean }, check: BranchCheck): void {
  const id = job.id;
  const events = readEvents(root, id);
  const stale = [...(scanned.fresh ? [] : ['the root repo']), ...plans.filter((p) => !p.fresh).map((p) => `repo ${p.repo}`)];
  if (stale.length) throw new ForgeError(`can't re-read the base of ${stale.join(', ')} from ${config.git.remote}'s push remote, so ${id}'s CI changes can't be checked; forge pr open won't push a branch it can't check`, 'push_held');
  let changes: CiChange[];
  try {
    changes = [
      ...pushCiChanges(job.worktree!, config, job, head, job.pr?.pushedSha),
      ...plans.flatMap((p) => pushCiChanges(p.worktree, config, { base: p.base }, p.checked, memberEntry(job, p.repo)?.pr?.pushedSha, p.repo)),
    ];
  } catch (e) {
    throw new ForgeError(`can't check ${id}'s CI changes (${(e as Error).message.split('\n')[0].slice(0, 200)}); forge pr open won't push a branch it can't check`, 'push_held');
  }
  if (check.flag && protectedApproved(check.flag, events)) {
    const approved = new Set(check.escalated.map((h) => `${h.path}\0${h.blob ?? ''}`));
    changes = changes.filter((c) => !approved.has(`${c.path}\0${c.blob ?? ''}`));
  }
  const holds: { kind: 'security' | 'secrets' | 'ci'; reason: string | null; paths?: string[] }[] = [
    { kind: 'security', reason: securityHoldReason(job) },
    { kind: 'secrets', reason: secretsHoldReason(scanned.scan, scanned.mode, head, plans.map((p) => ({ repo: p.repo, head: p.checked, scan: p.scan }))) },
    { kind: 'ci', reason: changes.length ? ciHoldReason(changes) : null, paths: changes.slice(0, LIST_LIMIT).map((c) => c.path) },
  ];
  for (const h of holds) {
    if (h.reason === null || pushHoldApproved(events, h.reason)) continue;
    logEvent(root, id, 'push-held', { kind: h.kind, reason: h.reason, head, ...(h.paths ? { paths: h.paths } : {}) });
    throw new ForgeError(`${h.reason}: nothing was pushed; a person approves it before forge pr open pushes ${id}`, 'push_held', `/forge approve ${id}`);
  }
}

/** What `forge pr gate` did: its `pr-gate` event, or `none` when the job has no open PR. */
export type PrGateResult =
  | { action: 'none' }
  | { action: 'set' | 'clear'; rule: MergeGate['rule'] | null; waitingOn: string | null; reason: string | null; reasons?: GateReason[]; number: number; label: string | null; labeled: boolean; body: boolean; error?: string };

const LABEL_DESCRIPTION = 'A person decides in Forge before this PR merges';

/**
 * `forge pr gate`: says on the open root PR why its merge waits on a person, or that it no longer
 * does. The gate is mergeGate over the job as step sees it, never a reason a session passes in. The
 * section (between the gate markers; a body without them keeps its text) is scanned for secrets
 * before any gh call, and `pr.needsHumanLabel` is added (created in the repo when missing) while a
 * gate is open and removed once none is, if the last sync set it. A GitHub failure is recorded as
 * `error` and never fails the job: the park, not the label, holds the merge.
 */
export function syncPrGate(root: string, config: Config, github: GitHub, id: string): PrGateResult {
  const job = loadJob(root, id);
  const number = job.pr?.state === 'OPEN' ? safePrNumber(job.pr.number) : null;
  if (number === null) return { action: 'none' };
  const x = loadStepInput(root, config, id);
  const gate = mergeGate({ x, f: computeFacts(x) });
  const events = readEvents(root, id);
  const text = gateSection(root, config, job, gate, events);
  refuseSecrets(root, config, [textUnit('(pr gate section)', text)], { what: 'the PR gate section', id, gate: 'pr' });
  const label = typeof config.pr.needsHumanLabel === 'string' && config.pr.needsHumanLabel ? config.pr.needsHumanLabel : null;
  const last = events.findLast((e) => e.type === 'pr-gate');
  let labeled = false;
  let body = false;
  let error: string | undefined;
  try {
    github.require();
    const slug = github.repoSlug(root, config);
    // A recorded number is only edited while GitHub agrees it is this job's branch and base.
    const read = (): string | null => {
      const view = github.viewBody(root, slug, number);
      assertJobPr(view, job.branch, job.base, `PR #${number} in ${slug}`);
      return view.body;
    };
    const current = read();
    const next = current === null ? null : spliceSection(current, GATE_START, GATE_END, text);
    if (next !== null && next !== current) {
      const file = path.join(jobDir(root, id), 'pr-gate-body.md');
      writeAtomic(file, next);
      // gh has no compare-and-swap edit: a body someone changed since the first read is left alone.
      if (read() !== current) throw new ForgeError(`the body of PR #${number} changed while the gate section was being written`, 'external');
      github.editBody(root, slug, number, file);
      body = true;
    }
    if (label && gate) {
      try {
        github.editLabels(root, slug, number, { add: [label], remove: [] });
      } catch (e) {
        if (!/not found/i.test((e as Error).message)) throw e;
        github.createLabel(root, slug, label, LABEL_DESCRIPTION);
        github.editLabels(root, slug, number, { add: [label], remove: [] });
      }
      labeled = true;
    } else if (label && !gate && last?.action === 'set' && last.labeled === true) github.editLabels(root, slug, number, { add: [], remove: [label] });
  } catch (e) {
    error = safeText(String((e as Error).message).split('\n')[0], 200);
  }
  // The reasons the body now shows, so PR14 syncs again when a rule's detail or paths change under the same reason.
  const result: PrGateResult = { action: gate ? 'set' : 'clear', rule: gate?.rule ?? null, waitingOn: gate?.waitingOn ?? null, reason: gate?.reason ?? null, ...(gate?.reasons ? { reasons: gate.reasons } : {}), number, label, labeled, body, ...(error ? { error } : {}) };
  logEvent(root, id, 'pr-gate', result);
  return result;
}

/**
 * Moves a stacked job back onto a normal base once its dependency merged. The open PR is
 * retargeted first; `job.base` changes only when that worked, so a failed call retries on the
 * next sync.
 */
export function retargetPr(
  root: string,
  config: Config,
  github: GitHub,
  id: string,
  base: string,
  dependency?: string,
): { from: string | null; to: string; pr: number | null } {
  const job = loadJob(root, id);
  const from = job.base;
  const number = config.pr.enabled && job.pr?.number && job.pr.state === 'OPEN' ? job.pr.number : null;
  if (number) {
    github.require();
    github.editBase(root, github.repoSlug(root, config), number, base);
  }
  setJob(root, id, { owned: { base } });
  logEvent(root, id, 'retargeted', { from, to: base, dependency, pr: number });
  return { from, to: base, pr: number };
}
