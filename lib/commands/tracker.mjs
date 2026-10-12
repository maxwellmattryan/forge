// @ts-check
// Tracker commands, starting jobs from tracker refs, and `forge sync` (PRs + trackers for every job).
import { createJob, isActive, listJobs, loadJob, logEvent, setJob, claimJob } from '../jobs.mjs';
import * as pr from '../pr.mjs';
import { listRequests } from '../requests.mjs';
import { loadTracker } from '../trackers/index.mjs';
import { ForgeError } from '../util.mjs';
import * as wt from '../worktree.mjs';
import { bodyFrom, list, req } from './args.mjs';

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
export async function trackerCmd(root, config, sub, rest, flags) {
  const tracker = await loadTracker(root, config);
  const ctx = { root, config };
  switch (sub) {
    case 'list':
      return tracker.list(ctx, { ready: Boolean(flags.ready), limit: flags.limit ? Number(flags.limit) : undefined }).map(({ body: _b, ...i }) => i);
    case 'get':
      return tracker.get(ctx, req(rest[0], 'ref'));
    case 'claim':
      return tracker.claim(ctx, req(rest[0], 'ref'), loadJob(root, req(rest[1], 'job id')));
    case 'update':
      tracker.update(ctx, req(rest[0], 'ref'), loadJob(root, req(rest[1], 'job id')));
      return { ok: true };
    case 'comment':
      tracker.comment(ctx, req(rest[0], 'ref'), bodyFrom(flags));
      return { ok: true };
    case 'create':
      return tracker.create(ctx, { title: req(flags.title, '--title'), body: bodyFrom(flags), labels: list(flags.label), parentRef: flags.parent ?? null });
    case 'close':
      tracker.close(ctx, req(rest[0], 'ref'), { reason: flags.reason });
      return { ok: true };
    default:
      throw new ForgeError('usage: forge tracker list|get|claim|update|comment|create|close');
  }
}

/** `forge next --claim` and `forge job from-ref`. @param {string} root @param {any} config @param {Record<string, any>} flags */
export async function nextCmd(root, config, flags) {
  const tracker = await loadTracker(root, config);
  const items = tracker.list({ root, config }, { ready: true, limit: Number(flags.limit ?? 20) });
  const item = items[0];
  if (!item) return { item: null };
  if (!flags.claim) return { item, more: items.length - 1 };
  return startFromRef(root, config, tracker, item.ref, flags);
}

/**
 * @param {string} root @param {any} config @param {import('../trackers/index.mjs').Tracker} tracker @param {string} ref @param {Record<string, any>} flags
 */
export async function startFromRef(root, config, tracker, ref, flags) {
  const ctx = { root, config };
  const item = tracker.get(ctx, ref);
  if (!item) throw new ForgeError(`no ${tracker.name} item "${ref}"`);
  const existing = listJobs(root).find((j) => isActive(j) && j.source && String(j.source.ref) === String(ref));
  if (existing) return { id: existing.id, existing: true, stage: existing.stage, state: existing.state };
  const job = createJob(root, config, { title: item.title, ref: item.ref, url: item.url ?? undefined, tracker: tracker.name, body: item.body ?? '' });
  const claim = tracker.claim(ctx, item.ref, job);
  if (!claim.ok) {
    setJob(root, job.id, { state: 'cancelled', reason: `tracker claim failed: ${claim.reason}` });
    throw new ForgeError(`could not claim ${ref}: ${claim.reason}`, 3);
  }
  if (flags.session) claimJob(root, job.id, String(flags.session));
  return { id: job.id, ref: item.ref, title: item.title, branch: job.branch };
}

/** Best-effort: tracker hiccups must never block the pipeline. @param {string} root @param {any} config @param {any} job */
export async function mirrorToTracker(root, config, job) {
  if (!job.source?.ref || job.kind === 'eval' || job.source.tracker !== config.tracker.kind) return;
  try {
    const tracker = await loadTracker(root, config);
    tracker.update({ root, config }, String(job.source.ref), job);
  } catch (e) {
    logEvent(root, job.id, 'tracker-error', { error: /** @type {Error} */ (e).message.slice(0, 300) });
  }
}

/** @param {string} root @param {any} config */
export async function syncAll(root, config) {
  const results = [];
  for (const job of listJobs(root).filter((j) => j.kind !== 'eval')) {
    const watch = isActive(job) ? job.pr?.number || job.stage === 'pr' : job.pr?.state === 'OPEN';
    if (!watch || !config.pr.enabled) continue;
    try {
      const before = job.pr ?? {};
      const r = pr.syncPr(root, config, job.id);
      const after = loadJob(root, job.id);
      await mirrorToTracker(root, config, after);
      let cleaned = false;
      if (after.state === 'done' && config.worktrees.cleanup === 'on-merge' && after.worktree) {
        try {
          wt.removeWorktree(root, job.id, { deleteBranch: true });
          cleaned = true;
        } catch {}
      }
      results.push({
        id: job.id,
        pr: r.pr?.number ?? null,
        state: r.pr?.state ?? null,
        merged: r.pr?.state === 'MERGED' && before.state !== 'MERGED',
        conflicts: r.pr?.conflicts ?? false,
        behindBy: r.pr?.behindBy ?? null,
        checks: r.pr?.checks?.state ?? null,
        newFeedback: (r.pr?.unresolvedThreads ?? 0) > (before.unresolvedThreads ?? 0) || (r.pr?.changesRequested ?? 0) > (before.changesRequested ?? 0),
        cleaned,
      });
    } catch (e) {
      results.push({ id: job.id, error: /** @type {Error} */ (e).message.slice(0, 300) });
    }
  }
  for (const job of listJobs(root).filter((j) => isActive(j) && j.children?.length)) {
    const kids = job.children.map((c) => {
      try {
        return loadJob(root, c);
      } catch {
        return null;
      }
    }).filter(Boolean);
    if (kids.length && kids.every((k) => ['done', 'cancelled'].includes(k.state))) {
      setJob(root, job.id, { stage: 'done', state: 'done', reason: 'all child jobs finished' });
      results.push({ id: job.id, umbrellaDone: true });
    }
  }
  return { synced: results.length, results, requests: listRequests(root, { status: 'pending' }).length };
}
