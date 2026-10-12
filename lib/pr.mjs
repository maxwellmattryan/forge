// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { loadJob, logEvent, setJob, jobDir } from './jobs.mjs';
import { exists } from './paths.mjs';
import { FactoryError, hasBinary, now, readText, run } from './util.mjs';

const MARKER = '<!-- software-factory -->';

/** @param {string} root @param {any} config */
export function repoSlug(root, config) {
  if (config.tracker?.github?.repo) return config.tracker.github.repo;
  const r = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: root, allowFail: true });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  throw new FactoryError('cannot determine the GitHub repository; set tracker.github.repo or run `gh auth login`');
}

function requireGh() {
  if (!hasBinary('gh')) throw new FactoryError('the GitHub CLI (gh) is required for PR features; install it or set pr.enabled: false');
}

/** @param {string} root @param {string[]} args */
function gh(root, args) {
  return run('gh', args, { cwd: root });
}

/** @param {string} root @param {string} query @param {Record<string, string|number>} vars */
function graphql(root, query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return JSON.parse(gh(root, args).stdout).data;
}

const PR_FIELDS = 'number,url,state,isDraft,title,headRefName,baseRefName,mergedAt,closedAt';

/**
 * A job may arrive for work that already has a PR (a long-running feature, a second session,
 * a human-started branch). Finding it first means the job continues that PR instead of forking it.
 * @param {string} root @param {any} config @param {string} id
 */
export function findPr(root, config, id) {
  requireGh();
  const job = loadJob(root, id);
  const slug = repoSlug(root, config);
  if (job.pr?.number) return view(root, slug, job.pr.number);
  const byBranch = JSON.parse(gh(root, ['pr', 'list', '-R', slug, '--head', job.branch, '--state', 'all', '--json', PR_FIELDS, '--limit', '5']).stdout);
  let pr = byBranch.find((/** @type {any} */ p) => p.state === 'OPEN') ?? byBranch[0] ?? null;
  if (!pr && job.source?.tracker === 'github' && /^\d+$/.test(String(job.source.ref))) {
    const [owner, name] = slug.split('/');
    const data = graphql(
      root,
      `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state headRefName}}}}}`,
      { owner, name, num: Number(job.source.ref) },
    );
    const nodes = data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
    const linked = nodes.find((/** @type {any} */ n) => n.state === 'OPEN') ?? nodes[0];
    if (linked) pr = view(root, slug, linked.number);
  }
  if (!pr) return null;
  const fields = { pr: { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, lastSyncedAt: now() } };
  if (pr.headRefName && pr.headRefName !== job.branch) Object.assign(fields, { branch: pr.headRefName });
  if (pr.baseRefName && pr.baseRefName !== job.base) Object.assign(fields, { base: pr.baseRefName });
  setJob(root, id, { fields });
  logEvent(root, id, 'pr-adopted', { number: pr.number, branch: pr.headRefName });
  return pr;
}

/** @param {string} root @param {string} slug @param {number} num */
function view(root, slug, num) {
  return JSON.parse(gh(root, ['pr', 'view', String(num), '-R', slug, '--json', PR_FIELDS]).stdout);
}

/**
 * @param {string} root @param {any} config @param {string} id @param {{title?:string, draft?:boolean}} [opts]
 */
export function openPr(root, config, id, opts = {}) {
  requireGh();
  const job = loadJob(root, id);
  if (!job.worktree) throw new FactoryError(`job ${id} has no worktree`);
  const slug = repoSlug(root, config);
  const ahead = run('git', ['rev-list', '--count', `${config.git.remote}/${job.base}..HEAD`], { cwd: job.worktree, allowFail: true });
  if (ahead.ok && ahead.stdout.trim() === '0') throw new FactoryError(`branch ${job.branch} has no commits ahead of ${job.base}`);
  pushBranch(job, config);
  const existing = findPr(root, config, id);
  if (existing && existing.state === 'OPEN') {
    logEvent(root, id, 'pr-updated', { number: existing.number });
    return { number: existing.number, url: existing.url, created: false };
  }
  const bodyFile = path.join(jobDir(root, id), 'pr-body.md');
  fs.writeFileSync(bodyFile, prBody(root, config, job));
  const args = ['pr', 'create', '-R', slug, '--base', job.base, '--head', job.branch, '--title', opts.title ?? job.title, '--body-file', bodyFile];
  if (opts.draft ?? config.pr.draft) args.push('--draft');
  for (const l of config.pr.labels ?? []) args.push('--label', l);
  for (const r of config.pr.reviewers ?? []) args.push('--reviewer', r);
  const url = gh(job.worktree, args).stdout.trim().split('\n').pop() ?? '';
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  setJob(root, id, { fields: { pr: { number, url, state: 'OPEN', isDraft: Boolean(opts.draft ?? config.pr.draft), openedAt: now(), lastSyncedAt: now() } } });
  logEvent(root, id, 'pr-opened', { number, url });
  return { number, url, created: true };
}

/** @param {any} job @param {any} config @param {{force?:boolean}} [opts] */
export function pushBranch(job, config, opts = {}) {
  const args = ['push', '-u', config.git.remote, `HEAD:refs/heads/${job.branch}`];
  if (opts.force) args.splice(1, 0, '--force-with-lease');
  run('git', args, { cwd: job.worktree });
}

/** @param {string} root @param {any} config @param {any} job */
function prBody(root, config, job) {
  const dir = jobDir(root, job.id);
  const custom = readText(path.join(dir, 'pr.md')).trim();
  const parts = [custom || `## Summary\n\n${firstParagraph(readText(path.join(dir, 'spec.md'))) || job.title}`];
  if (job.source?.tracker === 'github' && job.source.ref && config.pr.closeIssue) parts.push(`Closes #${job.source.ref}`);
  else if (job.source?.url) parts.push(`Source: ${job.source.url}`);
  parts.push(`${MARKER}\n_Built by the software factory · job \`${job.id}\`_`);
  return parts.join('\n\n') + '\n';
}

/** @param {string} md */
function firstParagraph(md) {
  return md.replace(/^#.*$/gm, '').trim().split(/\n\s*\n/)[0]?.trim() ?? '';
}

/**
 * Reconciles a job with reality on GitHub: merged/closed state, mergeability, how far behind
 * base it is, CI status and outstanding human feedback. This is what lets a later session
 * pick a job back up with an accurate picture.
 * @param {string} root @param {any} config @param {string} id
 */
export function syncPr(root, config, id) {
  requireGh();
  let job = loadJob(root, id);
  if (!job.pr?.number) {
    const found = findPr(root, config, id);
    if (!found) return { id, pr: null };
    job = loadJob(root, id);
  }
  const slug = repoSlug(root, config);
  const fields = 'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,closedAt,headRefName,baseRefName';
  const pr = JSON.parse(gh(root, ['pr', 'view', String(job.pr.number), '-R', slug, '--json', fields]).stdout);
  run('git', ['fetch', config.git.remote, '--prune'], { cwd: root, allowFail: true });
  const behind = run('git', ['rev-list', '--count', `${config.git.remote}/${pr.headRefName}..${config.git.remote}/${pr.baseRefName}`], { cwd: root, allowFail: true });
  const feedback = fetchFeedback(root, slug, pr.number);
  writeFeedback(root, id, pr, feedback);
  const checks = summarizeChecks(pr.statusCheckRollup ?? []);
  const next = {
    ...job.pr,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision || null,
    checks,
    behindBy: behind.ok ? Number(behind.stdout.trim()) : null,
    conflicts: pr.mergeable === 'CONFLICTING',
    unresolvedThreads: feedback.threads.length,
    changesRequested: feedback.reviews.filter((/** @type {any} */ r) => r.state === 'CHANGES_REQUESTED').length,
    mergedAt: pr.mergedAt || null,
    lastSyncedAt: now(),
  };
  /** @type {any} */
  const change = { fields: { pr: next } };
  if (pr.state === 'MERGED' && job.state !== 'done') Object.assign(change, { stage: 'done', state: 'done', reason: 'PR merged' });
  else if (pr.state === 'CLOSED' && !['cancelled', 'done'].includes(job.state)) Object.assign(change, { state: 'cancelled', reason: 'PR closed without merging' });
  else if (pr.state === 'OPEN' && job.stage === 'pr' && job.state !== 'running') Object.assign(change, { state: 'waiting', waitingOn: next.conflicts ? 'conflicts' : 'pr-review' });
  setJob(root, id, change);
  const prev = job.pr ?? {};
  logEvent(root, id, 'pr-synced', {
    state: pr.state,
    checks: checks.state,
    behindBy: next.behindBy,
    conflicts: next.conflicts,
    unresolvedThreads: next.unresolvedThreads,
    newFeedback: next.unresolvedThreads > (prev.unresolvedThreads ?? 0) || next.changesRequested > (prev.changesRequested ?? 0),
  });
  return { id, pr: next };
}

/** @param {any[]} rollup */
function summarizeChecks(rollup) {
  let passing = 0, failing = 0, pending = 0;
  for (const c of rollup) {
    const s = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) passing++;
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) failing++;
    else pending++;
  }
  const state = failing ? 'failing' : pending ? 'pending' : rollup.length ? 'passing' : 'none';
  return { state, passing, failing, pending };
}

/** @param {string} root @param {string} slug @param {number} num */
function fetchFeedback(root, slug, num) {
  const [owner, name] = slug.split('/');
  const data = graphql(
    root,
    `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){
      reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body createdAt url}}}}
      reviews(last:30){nodes{state body author{login} submittedAt url}}
      comments(last:50){nodes{author{login} body createdAt url}}}}}`,
    { owner, name, num },
  );
  const pr = data?.repository?.pullRequest ?? {};
  const human = (/** @type {any} */ c) => !String(c.author?.login ?? '').endsWith('[bot]') && !String(c.body ?? '').includes(MARKER);
  return {
    threads: (pr.reviewThreads?.nodes ?? []).filter((/** @type {any} */ t) => !t.isResolved && t.comments.nodes.some(human)),
    reviews: (pr.reviews?.nodes ?? []).filter((/** @type {any} */ r) => human(r) && (r.body?.trim() || r.state === 'CHANGES_REQUESTED')),
    comments: (pr.comments?.nodes ?? []).filter(human),
  };
}

/** @param {string} root @param {string} id @param {any} pr @param {any} fb */
function writeFeedback(root, id, pr, fb) {
  const out = [`# PR feedback · #${pr.number}`, '', `Synced ${now()} · ${pr.url}`, ''];
  if (!fb.threads.length && !fb.reviews.length && !fb.comments.length) out.push('_No outstanding human feedback._');
  if (fb.reviews.length) {
    out.push('## Reviews', '');
    for (const r of fb.reviews) out.push(`- **${r.state}** by @${r.author?.login} (${r.submittedAt}): ${oneLine(r.body) || '(no summary)'}`);
    out.push('');
  }
  if (fb.threads.length) {
    out.push('## Unresolved review threads', '');
    for (const t of fb.threads) {
      out.push(`### \`${t.path}${t.line ? `:${t.line}` : ''}\`${t.isOutdated ? ' (outdated)' : ''}`);
      for (const c of t.comments.nodes) out.push(`- @${c.author?.login}: ${oneLine(c.body)}`);
      out.push('');
    }
  }
  if (fb.comments.length) {
    out.push('## Conversation', '');
    for (const c of fb.comments) out.push(`- @${c.author?.login} (${c.createdAt}): ${oneLine(c.body)}`);
  }
  fs.writeFileSync(path.join(jobDir(root, id), 'pr-feedback.md'), out.join('\n') + '\n');
}

/** @param {string} s */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);

/**
 * Brings the job branch up to date with base. On conflict it aborts cleanly and reports the
 * files, leaving the fix-now/defer/ask decision to the orchestrator and the repo's policy.
 * @param {string} root @param {any} config @param {string} id @param {{strategy?:'merge'|'rebase'}} [opts]
 */
export function integrate(root, config, id, opts = {}) {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new FactoryError(`job ${id} has no worktree`);
  const cwd = job.worktree;
  const dirty = run('git', ['status', '--porcelain'], { cwd }).stdout.trim();
  if (dirty) throw new FactoryError(`worktree for ${id} has uncommitted changes; the builder must commit first`);
  run('git', ['fetch', config.git.remote], { cwd, allowFail: true });
  const remoteBase = `${config.git.remote}/${job.base}`;
  const upstream = run('git', ['rev-parse', '--verify', '--quiet', remoteBase], { cwd, allowFail: true }).ok ? remoteBase : job.base;
  const behind = Number(run('git', ['rev-list', '--count', `HEAD..${upstream}`], { cwd }).stdout.trim());
  if (behind === 0) {
    logEvent(root, id, 'integrated', { behind: 0 });
    return { ok: true, behind: 0, strategy: null, rewritten: false };
  }
  const strategy = opts.strategy ?? (job.pr?.state === 'OPEN' ? config.pr.updateStrategy : 'rebase');
  const attempt = strategy === 'rebase' ? run('git', ['rebase', upstream], { cwd, allowFail: true }) : run('git', ['merge', '--no-edit', upstream], { cwd, allowFail: true });
  if (!attempt.ok) {
    const conflicts = run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd, allowFail: true }).stdout.split('\n').filter(Boolean);
    run('git', [strategy === 'rebase' ? 'rebase' : 'merge', '--abort'], { cwd, allowFail: true });
    logEvent(root, id, 'integrate-conflicts', { strategy, conflicts, behind });
    return { ok: false, behind, strategy, conflicts };
  }
  logEvent(root, id, 'integrated', { behind, strategy });
  return { ok: true, behind, strategy, rewritten: strategy === 'rebase' };
}

/** @param {string} root @param {any} config @param {string} id */
export function mergePr(root, config, id) {
  requireGh();
  const job = loadJob(root, id);
  if (!job.pr?.number) throw new FactoryError(`job ${id} has no PR`);
  const slug = repoSlug(root, config);
  const args = ['pr', 'merge', String(job.pr.number), '-R', slug, `--${config.merge.method}`];
  const direct = run('gh', args, { cwd: root, allowFail: true });
  if (direct.ok) {
    logEvent(root, id, 'pr-merged', { number: job.pr.number, method: config.merge.method });
    return { merged: true };
  }
  const queued = run('gh', [...args, '--auto'], { cwd: root, allowFail: true });
  logEvent(root, id, queued.ok ? 'pr-auto-merge' : 'pr-merge-failed', { number: job.pr.number, error: queued.ok ? undefined : (queued.stderr || direct.stderr).trim() });
  return { merged: false, autoMerge: queued.ok, error: queued.ok ? null : (queued.stderr || direct.stderr).trim() };
}
