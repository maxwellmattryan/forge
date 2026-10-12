// @ts-check
// `forge job …`: every write to a job's state goes through here.
import path from 'node:path';
import { reviewerChecklist } from '../config.mjs';
import { claimJob, createJob, isActive, listJobs, loadJob, logEvent, parseDecision, progress, recordAgent, releaseJob, roundVerdicts, setJob, updateJob, jobDir } from '../jobs.mjs';
import { paths, exists } from '../paths.mjs';
import { jobScope } from '../scope.mjs';
import { loadTracker } from '../trackers/index.mjs';
import { importClaudeCodeTranscript } from '../usage.mjs';
import { ForgeError, coerce, getPath, run } from '../util.mjs';
import { bodyFrom, list, req } from './args.mjs';
import { mirrorToTracker, startFromRef } from './tracker.mjs';

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
export async function jobCmd(root, config, sub, rest, flags) {
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
      /** @type {Record<string, any>} */
      const fields = {};
      for (const kv of flags.field === undefined || flags.field === true ? [] : [].concat(flags.field).map(String)) {
        const eq = kv.indexOf('=');
        if (eq < 1) throw new ForgeError(`--field expects key=value, got "${kv}"`);
        fields[kv.slice(0, eq)] = coerce(kv.slice(eq + 1));
      }
      const job = setJob(root, req(id, 'job id'), {
        stage: flags.stage,
        state: flags.state,
        waitingOn: flags['waiting-on'] === undefined ? undefined : flags['waiting-on'] === 'none' ? null : flags['waiting-on'],
        reason: flags.reason,
        note: flags.note,
        fields,
      });
      await mirrorToTracker(root, config, job);
      return { id: job.id, stage: job.stage, state: job.state, waitingOn: job.waitingOn };
    }
    case 'claim': {
      const job = claimJob(root, req(id, 'job id'), req(flags.session, '--session'), Boolean(flags.force));
      return { id: job.id, owner: job.owner };
    }
    case 'release':
      releaseJob(root, req(id, 'job id'));
      return { id, released: true };
    case 'note':
      logEvent(root, req(id, 'job id'), 'note', { text: rest.slice(1).join(' ') || bodyFrom(flags) });
      return { ok: true };
    case 'human': {
      const action = req(rest[1], 'action (approve-spec|revise-spec|approve|rework|answer|reject)');
      logEvent(root, req(id, 'job id'), 'human', { action, note: flags.note ?? (rest.slice(2).join(' ') || null) });
      return { ok: true };
    }
    case 'agent': {
      const phase = req(rest[1], 'start|end');
      if (!['start', 'end'].includes(phase)) throw new ForgeError('phase must be start or end');
      let usage;
      if (phase === 'end') {
        if (flags.import && flags['agent-id']) usage = importClaudeCodeTranscript(String(flags['agent-id'])) ?? undefined;
        if (!usage && (flags.tokens || flags['tool-uses'] || flags['duration-ms']))
          usage = { totalTokens: Number(flags.tokens ?? 0), toolUses: Number(flags['tool-uses'] ?? 0), durationMs: Number(flags['duration-ms'] ?? 0) };
        if (usage && !usage.toolUses && flags['tool-uses']) usage.toolUses = Number(flags['tool-uses']);
      }
      const job = recordAgent(
        root,
        req(id, 'job id'),
        {
          role: req(flags.role, '--role'),
          phase: /** @type {'start'|'end'} */ (phase),
          model: flags.model ?? usage?.model ?? undefined,
          agentId: flags['agent-id'],
          status: flags.status,
          summary: flags.summary,
          usage: usage ? { ...usage, transcript: undefined } : undefined,
        },
        config,
      );
      const a = job.agents[String(flags.role)];
      return { role: flags.role, status: a.status, model: a.model, usage: usage ? { tokens: usage.totalTokens, exact: Boolean(usage.exact) } : null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd };
    }
    case 'round': {
      const job = updateJob(root, req(id, 'job id'), (j) => {
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
      /** @type {number|'integration'} */
      const round = integration ? 'integration' : Number(flags.round ?? job.round);
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
    case 'progress':
      return progress(root, req(id, 'job id'));
    case 'paths':
      return jobPaths(root, config, loadJob(root, req(id, 'job id')));
    case 'scope':
      return jobScope(root, config, req(id, 'job id'));
    default:
      throw new ForgeError('usage: forge job new|from-ref|list|show|get|set|claim|release|note|human|agent|round|verdicts|decision|progress|paths|scope');
  }
}

/**
 * Absolute paths an agent prompt needs, so the orchestrator can hand them over verbatim.
 * @param {string} root @param {any} config @param {any} job
 */
export function jobPaths(root, config, job) {
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
    instructions: (config.project.instructions ?? []).map((/** @type {string} */ f) => path.join(job.worktree ?? root, f)).filter(exists),
    checklists: Object.fromEntries((job.reviewers ?? []).map((/** @type {string} */ r) => [r, reviewerChecklist(root, r, config.review.panel.find((/** @type {any} */ x) => x.name === r)?.checklist)])),
  };
}

/** @param {string} root @param {any} job */
export function compactJob(root, job) {
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
