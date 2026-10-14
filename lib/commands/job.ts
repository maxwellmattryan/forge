// `forge job …`: every write to a job's state goes through here.
import path from 'node:path';
import { jobAcs } from '../acs.ts';
import { budgetCmd, enforceBudget } from '../budget.ts';
import { reviewerChecklist } from '../config.ts';
import { claimRespectingDeps, refreshDependencyWait, validateDependsOn } from '../deps.ts';
import { claimJob, createJob, importCursor, isActive, listJobs, loadJob, logEvent, parseDecision, progress, recordAgent, releaseJob, roundVerdicts, setJob, updateJob, jobDir } from '../jobs.ts';
import { paths, exists } from '../paths.ts';
import { jobScope } from '../scope.ts';
import { loadTracker } from '../trackers/index.ts';
import { importClaudeCodeTranscript } from '../usage.ts';
import { ForgeError, coerce, getPath, run } from '../util.ts';
import { bodyFrom, list, req } from './args.ts';
import { mirrorToTracker, startFromRef } from './tracker.ts';
import type { AgentUsage, Config, Job } from '../types.ts';

/** The result is printed as JSON. */
export async function jobCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  const id = rest[0];
  switch (sub) {
    case 'new': {
      const job = createJob(root, config, {
        title: req(flags.title, '--title'),
        ref: flags.ref,
        url: flags.url,
        tracker: flags.tracker,
        body: bodyFrom(flags),
        parent: flags.parent,
        branch: flags.branch,
        kind: flags.kind,
        slug: flags.slug,
        services: list(flags.services),
      });
      if (flags.session) claimJob(root, job.id, String(flags.session));
      return { id: job.id, branch: job.branch, dir: path.relative(root, jobDir(root, job.id)) };
    }
    case 'from-ref': {
      const tracker = await loadTracker(root, config);
      return startFromRef(root, config, tracker, req(id, 'tracker ref'), flags);
    }
    case 'list': {
      const jobs = listJobs(root).filter((j) => (flags.all ? true : isActive(j)));
      return jobs.map((j) => ({ id: j.id, title: j.title, stage: j.stage, state: j.state, waitingOn: j.waitingOn, round: j.round, pr: j.pr?.number ?? null, owner: j.owner?.session ?? null }));
    }
    case 'show': {
      const job = loadJob(root, req(id, 'job id'));
      return flags.full ? job : compactJob(root, job);
    }
    case 'get':
      return getPath(loadJob(root, req(id, 'job id')), rest[1] ?? '') ?? null;
    case 'set': {
      const fields: Record<string, any> = {};
      for (const kv of flags.field === undefined || flags.field === true ? [] : ([] as unknown[]).concat(flags.field).map(String)) {
        const eq = kv.indexOf('=');
        if (eq < 1) throw new ForgeError(`--field expects key=value, got "${kv}"`);
        fields[kv.slice(0, eq)] = coerce(kv.slice(eq + 1));
      }
      // Checked before anything is written, so a bad list leaves job.json untouched.
      if ('dependsOn' in fields) fields.dependsOn = validateDependsOn(root, req(id, 'job id'), fields.dependsOn);
      let job = setJob(root, req(id, 'job id'), {
        stage: flags.stage,
        state: flags.state,
        waitingOn: flags['waiting-on'] === undefined ? undefined : flags['waiting-on'] === 'none' ? null : flags['waiting-on'],
        reason: flags.reason,
        note: flags.note,
        fields,
      });
      if ('dependsOn' in fields) {
        refreshDependencyWait(root, job.id);
        job = loadJob(root, job.id);
      }
      await mirrorToTracker(root, config, job);
      return { id: job.id, stage: job.stage, state: job.state, waitingOn: job.waitingOn };
    }
    case 'claim': {
      const { job, overridden } = claimRespectingDeps(root, req(id, 'job id'), req(flags.session, '--session'), Boolean(flags.force));
      return { id: job.id, owner: job.owner, ...(overridden.length ? { dependenciesOverridden: overridden } : {}) };
    }
    case 'release':
      releaseJob(root, req(id, 'job id'));
      return { id, released: true };
    case 'note':
      logEvent(root, req(id, 'job id'), 'note', { text: rest.slice(1).join(' ') || bodyFrom(flags) });
      return { ok: true };
    case 'human': {
      const action = req(rest[1], 'action (approve-spec|revise-spec|approve-split|revise-split|approve|rework|answer|reject)');
      logEvent(root, req(id, 'job id'), 'human', { action, note: flags.note ?? (rest.slice(2).join(' ') || null) });
      return { ok: true };
    }
    case 'agent': {
      const phase = req(rest[1], 'start|end');
      if (!['start', 'end'].includes(phase)) throw new ForgeError('phase must be start or end');
      let usage: (AgentUsage & { transcript?: string; through?: string | null }) | undefined;
      let since: string | null = null;
      if (phase === 'end') {
        if (flags.import && flags['agent-id']) {
          since = importCursor(loadJob(root, req(id, 'job id')), String(flags['agent-id']));
          usage = importClaudeCodeTranscript(String(flags['agent-id']), { since }) ?? undefined;
        }
        if (!usage && (flags.tokens || flags['tool-uses'] || flags['duration-ms']))
          usage = { totalTokens: Number(flags.tokens ?? 0), toolUses: Number(flags['tool-uses'] ?? 0), durationMs: Number(flags['duration-ms'] ?? 0) };
        if (usage && !usage.toolUses && flags['tool-uses']) usage.toolUses = Number(flags['tool-uses']);
      }
      const job = recordAgent(
        root,
        req(id, 'job id'),
        {
          role: req(flags.role, '--role'),
          phase: phase as 'start' | 'end',
          model: flags.model ?? usage?.model ?? undefined,
          agentId: flags['agent-id'],
          status: flags.status,
          summary: flags.summary,
          // The transcript's path and cursor are set to undefined, so the usage job.json records is
          // only token counts; the cursor goes to the agent record instead.
          usage: usage ? ({ ...usage, transcript: undefined, through: undefined } as AgentUsage) : undefined,
          importedThrough: usage?.through,
        },
        config,
      );
      const a = job.agents[String(flags.role)];
      const budget = phase === 'end' ? enforceBudget(root, config, job.id, 'agent-end') : null;
      return { role: flags.role, status: a.status, model: a.model, usage: usage ? { tokens: usage.totalTokens, exact: Boolean(usage.exact), ...(since && usage.transcript ? { since } : {}) } : null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd, ...(budget ? { budget } : {}) };
    }
    case 'round': {
      // Checked before incrementing, so after approval re-running `forge job round` starts the round.
      const budget = enforceBudget(root, config, req(id, 'job id'), 'round');
      if (budget) {
        const j = loadJob(root, String(id));
        return { round: j.round, maxRounds: j.maxRounds, exhausted: j.round > j.maxRounds, budget };
      }
      const job = updateJob(root, String(id), (j) => {
        j.round += 1;
      });
      logEvent(root, job.id, 'round', { round: job.round });
      return { round: job.round, maxRounds: job.maxRounds, exhausted: job.round > job.maxRounds };
    }
    case 'verdicts': {
      const job = loadJob(root, req(id, 'job id'));
      // The integration review is a mini round after conflict resolution; it is logged as an
      // event only, because stats, retro and the dashboard read job.verdicts keys as numbers.
      const integration = flags.round === 'integration';
      if (flags.round !== undefined && !integration && !/^[1-9]\d*$/.test(String(flags.round))) throw new ForgeError('--round must be a positive integer or "integration"');
      const round: number | 'integration' = integration ? 'integration' : Number(flags.round ?? job.round);
      const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : integration ? ['code'] : job.reviewers;
      if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
      if (flags.malformed !== undefined && flags.malformed !== 'changes') throw new ForgeError('--malformed accepts only "changes"');
      const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn, { malformedAs: flags.malformed });
      // The sha reviewers saw is evidence; it tells a later reader whether the review is still current.
      const sha = job.worktree && exists(job.worktree) ? run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree, allowFail: true }).stdout.trim() || null : null;
      if (v.complete) {
        const verdicts = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict]));
        const coerced = Object.entries(v.reviewers).filter(([, r]) => r.coerced).map(([k]) => k);
        if (integration) logEvent(root, job.id, 'integration-review', { outcome: v.outcome, sha, reviewers: verdicts, coerced: coerced.length ? coerced : undefined });
        else {
          setJob(root, job.id, { fields: { [`verdicts.${round}`]: verdicts } });
          logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome, sha, coerced: coerced.length ? coerced : undefined });
        }
        if (coerced.length) logEvent(root, job.id, 'note', { text: `${integration ? 'integration review' : `round ${round}`}: malformed review(s) from ${coerced.join(', ')} counted as CHANGES` });
      }
      if (flags.compact) return { round, complete: v.complete, outcome: v.outcome, sha, reviewers: Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict])) };
      return { ...v, sha };
    }
    case 'decision': {
      const d = parseDecision(root, req(id, 'job id'));
      if (d.decision) {
        setJob(root, id, { fields: { decision: d.decision } });
        logEvent(root, id, 'decision', d);
      }
      return d;
    }
    case 'budget':
      return budgetCmd(root, config, req(id, 'job id'), { set: list(flags.set), ack: Boolean(flags.ack) });
    case 'progress':
      return progress(root, req(id, 'job id'));
    case 'paths':
      return jobPaths(root, config, loadJob(root, req(id, 'job id')));
    case 'scope':
      return jobScope(root, config, req(id, 'job id'));
    case 'acs':
      return jobAcs(root, req(id, 'job id'));
    default:
      throw new ForgeError('usage: forge job new|from-ref|list|show|get|set|claim|release|note|human|agent|round|budget|verdicts|decision|progress|paths|scope|acs');
  }
}

/**
 * Absolute paths an agent prompt needs, so the orchestrator can hand them over verbatim.
 */
export function jobPaths(root: string, config: Config, job: Job): Record<string, unknown> {
  const dir = jobDir(root, job.id);
  const p = paths(root);
  const round = Math.max(job.round, 1);
  return {
    jobDir: dir,
    worktree: job.worktree,
    request: path.join(dir, 'request.md'),
    plan: path.join(dir, 'plan.md'),
    spec: path.join(dir, 'spec.md'),
    design: path.join(dir, 'design.md'),
    mockup: path.join(dir, 'mockup.html'),
    tasks: path.join(dir, 'tasks.md'),
    build: path.join(dir, 'build.md'),
    verify: path.join(dir, 'verify', `round-${job.round}.md`),
    scope: path.join(dir, 'scope.md'),
    screenshots: path.join(dir, 'screenshots'),
    reviewDir: path.join(dir, 'review', `round-${round}`),
    previousReviewDir: round > 1 ? path.join(dir, 'review', `round-${round - 1}`) : null,
    integrationReview: path.join(dir, 'review', 'integration', 'code.md'),
    decision: path.join(dir, 'decision.md'),
    questions: path.join(dir, 'questions.md'),
    runbook: path.join(dir, 'runbook.md'),
    prFeedback: path.join(dir, 'pr-feedback.md'),
    prBody: path.join(dir, 'pr.md'),
    feedback: path.join(dir, 'feedback.md'),
    learnings: path.join(p.notes, 'learnings.md'),
    notesDir: p.notes,
    config: p.config,
    instructions: (config.project.instructions ?? []).map((f: string) => path.join(job.worktree ?? root, f)).filter(exists),
    checklists: Object.fromEntries((job.reviewers ?? []).map((r: string) => [r, reviewerChecklist(root, r, config.review.panel.find((x) => x.name === r)?.checklist)])),
  };
}

/** The job as `forge job show` prints it without --full. */
export function compactJob(root: string, job: Job): Record<string, unknown> {
  const lastVerify = job.verifyRuns[job.verifyRuns.length - 1] ?? null;
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    stage: job.stage,
    state: job.state,
    waitingOn: job.waitingOn,
    reason: job.reason,
    round: job.round,
    maxRounds: job.maxRounds,
    reviewers: job.reviewers,
    lastVerdicts: job.verdicts[job.round] ?? null,
    verify: job.verify[job.round] ?? null,
    verified: lastVerify ? { round: lastVerify.round, attempt: lastVerify.attempt, ok: lastVerify.ok, sha: lastVerify.sha } : null,
    decision: job.decision,
    branch: job.branch,
    base: job.base,
    worktree: job.worktree,
    port: job.port,
    pr: job.pr ? { number: job.pr.number, url: job.pr.url, state: job.pr.state, checks: job.pr.checks?.state, behindBy: job.pr.behindBy, conflicts: job.pr.conflicts, unresolvedThreads: job.pr.unresolvedThreads } : null,
    source: job.source,
    owner: job.owner?.session ?? null,
    progress: progress(root, job.id),
    tokens: job.usage.totalTokens,
    estCostUsd: job.usage.estCostUsd,
  };
}
