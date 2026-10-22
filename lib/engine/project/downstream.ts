// Downstream verification: when a job changes a library, the member repos that consume it join the
// job as verify-only repos, so verify runs their tests against the job's changes through local links
// (docs/CONFIG.md "Downstream verification", ARCHITECTURE.md "Job repos"). Candidates are always
// recomputed from config, the job and its events, never named by the caller: this is the one path by
// which a daemon session adds a repo, and it can add only a verify-only one, which never pushes.

import path from 'node:path';
import { verifySteps } from '../../core/config/load.ts';
import { addJobRepo, memberClone, memberRepos } from './job-repos.ts';
import { loadJob, logEvent, readEvents } from '../../core/job/store.ts';
import { declaredLinks } from './links.ts';
import { REPO_NAME } from './member-repos.ts';
import { projectGraph } from './graph.ts';
import { daemonScope } from '../../core/job/requests.ts';
import { isMap } from '../../core/shape.ts';
import type { Config, Job, JobEvent } from '../../core/types.ts';
import { ForgeError } from '../../core/errors.ts';

export interface DownstreamSkip {
  repo: string;
  reason: string;
}

export interface DownstreamCandidates {
  add: string[];
  skipped: DownstreamSkip[];
}


/** The verify-only members whose latest `job-repo-added` event says `downstream: true`. */
export function downstreamMembers(job: Pick<Job, 'repos'>, events: JobEvent[]): Set<string> {
  const latest = new Map<string, JobEvent>();
  for (const e of events) if (e.type === 'job-repo-added' && typeof e.repo === 'string') latest.set(e.repo, e);
  return new Set(memberRepos(job).filter((m) => m.verifyOnly && latest.get(m.repo)?.downstream === true).map((m) => m.repo));
}

/**
 * Members job.json marks as edited although they joined as downstream consumers and no
 * `job-repo-promoted` event followed: a hand edit, so nothing may push them or open their PR.
 */
export function unpromotedDownstream(job: Pick<Job, 'repos'>, events: JobEvent[]): string[] {
  const added = new Map<string, number>();
  const promoted = new Map<string, number>();
  events.forEach((e, i) => {
    if (typeof e.repo !== 'string') return;
    if (e.type === 'job-repo-added') added.set(e.repo, i);
    else if (e.type === 'job-repo-promoted') promoted.set(e.repo, i);
  });
  return memberRepos(job)
    .filter((m) => {
      const at = added.get(m.repo);
      return !m.verifyOnly && at !== undefined && events[at].downstream === true && (promoted.get(m.repo) ?? -1) < at;
    })
    .map((m) => m.repo);
}

/**
 * The repos the job changes: the root (null) and every member that is not verify-only, except an
 * unpromoted downstream consumer a hand edit marked edited. Discovery and the push guard read the
 * same definition, so such an edit can't pull the consumer's own consumers onto the job.
 */
export function changedRepos(job: Pick<Job, 'repos'>, events: JobEvent[]): Set<string | null> {
  const unpromoted = new Set(unpromotedDownstream(job, events));
  return new Set<string | null>([null, ...memberRepos(job).filter((m) => !m.verifyOnly && !unpromoted.has(m.repo)).map((m) => m.repo)]);
}

/** Whether a human removed `repo` from the job: a `job-repo-removed` after its latest `job-repo-added`. */
function removedByHuman(events: JobEvent[], repo: string): boolean {
  let added = -1;
  let removed = -1;
  events.forEach((e, i) => {
    if (e.repo !== repo) return;
    if (e.type === 'job-repo-added') added = i;
    else if (e.type === 'job-repo-removed') removed = i;
  });
  return removed > added;
}

/**
 * The direct consumers of the job's changed repos that are not on the job yet, in config `repos`
 * order: each one to add, or skipped with the first reason that applies. Pure: config, job and events
 * only. `rootName` labels the root repo in a reason (the root checkout's directory name).
 */
export function downstreamRepos(config: Pick<Config, 'components' | 'repos' | 'verify' | 'downstream'>, job: Pick<Job, 'repos'>, events: JobEvent[], rootName = 'root'): DownstreamCandidates {
  const out: DownstreamCandidates = { add: [], skipped: [] };
  const settings = config.downstream;
  if (!isMap(settings) || settings.enabled !== true) return out;
  const changed = changedRepos(job, events);
  const onJob = new Set(memberRepos(job).map((m) => m.repo));
  const graph = projectGraph(config);
  const repoOf = new Map(graph.components.map((c) => [c.name, c.repo]));
  const links = declaredLinks(config);
  const steps = [...new Set(verifySteps(config.verify))];
  const components: unknown[] = Array.isArray(config.components) ? config.components : [];
  const skip = new Set(Array.isArray(settings.skip) ? settings.skip : []);
  const max = Number.isInteger(settings.max) ? settings.max : 0;
  let count = downstreamMembers(job, events).size;
  const seen = new Set<string>();
  for (const r of Array.isArray(config.repos) ? (config.repos as unknown[]) : []) {
    const name = isMap(r) ? r.name : undefined;
    if (typeof name !== 'string' || !REPO_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    if (onJob.has(name)) continue;
    // The changed repos this one's components depend on, in edge order.
    const deps = graph.edges.filter((e) => e.target === 'component' && repoOf.get(e.from) === name && changed.has(repoOf.get(e.to) ?? null)).map((e) => repoOf.get(e.to) ?? null);
    if (!deps.length) continue;
    const skipped = (reason: string) => out.skipped.push({ repo: name, reason });
    if (skip.has(name)) {
      skipped('listed in downstream.skip');
      continue;
    }
    if (removedByHuman(events, name)) {
      skipped('removed from the job by a human');
      continue;
    }
    if (!links.some((l) => l.consumerRepo === name && changed.has(l.dependencyRepo))) {
      skipped(`no link on its dependsOn edge to ${deps[0] ?? rootName}, so it would test the released library`);
      continue;
    }
    const runs = components.some((c) => isMap(c) && c.repo === name && isMap(c.commands) && steps.some((s) => typeof c.commands[s] === 'string' && c.commands[s].trim() !== ''));
    if (!runs) {
      skipped('defines no verify step command');
      continue;
    }
    if (count >= max) {
      skipped(`over downstream.max (${max})`);
      continue;
    }
    count++;
    out.add.push(name);
  }
  return out;
}

export interface DownstreamResult {
  id: string;
  added: string[];
  skipped: DownstreamSkip[];
}

/** Stages and states in which a job's repos can no longer widen (as repo-proposals.ts closedFor). */
function closedFor(job: Pick<Job, 'state' | 'stage'>): boolean {
  return ['done', 'cancelled', 'failed'].includes(job.state) || ['pr', 'done'].includes(job.stage);
}

/**
 * `forge job repo downstream`: adds each candidate whose clone passes doctor's check as a verify-only
 * member and logs one `downstream-checked` event. Only the job's own daemon session, or a human
 * outside the daemon, may run it; the scope check comes before anything is read.
 */
export function addDownstreamRepos(root: string, config: Config, id: string): DownstreamResult {
  const scope = daemonScope();
  if ('problem' in scope) throw new ForgeError(scope.problem);
  if (scope.daemon && scope.scope !== id) throw new ForgeError(`forge job repo downstream runs only in job ${id}'s own session or a human's terminal`, 1);
  const job = loadJob(root, id);
  if (job.kind === 'eval') throw new ForgeError(`job ${id} is an eval job; its repos are fixed`, 1);
  if (closedFor(job)) throw new ForgeError(`job ${id} is at stage ${job.stage} (${job.state}); repos can be added only before its PR`, 1);
  const found = downstreamRepos(config, job, readEvents(root, id), path.basename(root));
  const added: string[] = [];
  const skipped = [...found.skipped];
  for (const name of found.add) {
    try {
      memberClone(root, config, name);
    } catch (e) {
      skipped.push({ repo: name, reason: (e as Error).message });
      continue;
    }
    addJobRepo(root, config, id, name, true, { downstream: true });
    added.push(name);
  }
  logEvent(root, id, 'downstream-checked', { added, skipped });
  return { id, added, skipped };
}
