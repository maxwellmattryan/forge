// @ts-check
// The `forge` CLI: the only writer of Forge state. Agents and the orchestrator call it
// instead of hand-editing JSON, so data shapes stay valid no matter which model is driving.
// Output is compact JSON (or a terse table for `status`) to keep orchestrator context small.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, validateConfig, defaults, stringifyConfig, reviewerChecklist } from './config.mjs';
import { detect } from './detect.mjs';
import * as evals from './evals.mjs';
import {
  claimJob, createJob, isActive, listJobs, loadJob, logEvent, parseDecision, progress, readEvents,
  recordAgent, releaseJob, roundVerdicts, setJob, updateJob, jobDir,
} from './jobs.mjs';
import { mainRoot, paths, exists, PLUGIN_ROOT } from './paths.mjs';
import * as pr from './pr.mjs';
import { ackRequest, enqueue, listRequests } from './requests.mjs';
import { prepareRetro, retroDue } from './retro.mjs';
import { roster } from './roster.mjs';
import { migrateConfig, serializeJob, normalizeJob } from './schema.mjs';
import { computeStats } from './stats.mjs';
import { loadTracker } from './trackers/index.mjs';
import { importClaudeCodeTranscript } from './usage.mjs';
import { ForgeError, coerce, deepMerge, getPath, hasBinary, readJson, readText, run, sleepSync, writeJsonAtomic } from './util.mjs';
import * as wt from './worktree.mjs';
import * as yaml from './yaml.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const pos = [];
  /** @type {Record<string, any>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key in flags) flags[key] = [].concat(flags[key], val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** @param {any} v */
const list = (v) => (v === undefined || v === true ? [] : [].concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));

/** @param {any} data @param {Record<string, any>} flags */
function out(data, flags) {
  if (typeof data === 'string') return void process.stdout.write(data.endsWith('\n') ? data : data + '\n');
  process.stdout.write(JSON.stringify(data, null, flags.pretty ? 2 : 0) + '\n');
}

/** @param {Record<string, any>} flags */
function bodyFrom(flags) {
  if (flags['body-file']) return flags['body-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(String(flags['body-file']), 'utf8');
  return flags.body ? String(flags.body) : '';
}

const HELP = `forge — software factory CLI (state, worktrees, PRs, trackers, evals, dashboard)

  forge status                       active jobs at a glance (add --all for finished)
  forge next [--claim --session S]   next ready tracker item (optionally start a job for it)
  forge job new|from-ref|list|show|get|set|claim|release|note|human|agent|round|verdicts|decision|progress|paths
  forge worktree create|remove|path|prune <id>
  forge run <id> <command> [--background]   forge stop <id>   forge verify <id>
  forge integrate <id> [--strategy merge|rebase]
  forge pr find|open|sync|merge <id>   forge sync          reconcile PRs + trackers for all jobs
  forge tracker list|get|claim|update|comment|create|close
  forge stats [--since DATE] [--json]  forge roster   forge retro due|prepare <job>
  forge eval list|new|mine|start|grade|runs|compare|report
  forge requests [list|add|ack]
  forge init detect|write --answers FILE   forge config [show|get PATH|validate]
  forge doctor   forge migrate   forge dash [--background|--stop] [--port N]   forge version

Docs: ${path.join(PLUGIN_ROOT, 'docs')}`;

/** @param {string[]} argv */
export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) return out(HELP, flags);
  if (cmd === 'version') return out({ version: evals.forgeVersion() }, flags);

  const root = mainRoot();
  const { config, initialized } = loadConfig(root);
  const ctx = { root, config };
  const needInit = () => {
    if (!initialized) throw new ForgeError('this repo has no .forge/config.yml yet; run `/forge init` (or `forge init write --answers FILE`)', 2);
  };

  switch (cmd) {
    case 'init': {
      if (sub === 'detect') return out(detect(root), flags);
      if (sub === 'write') {
        const answers = flags.answers ? readJson(String(flags.answers)) : {};
        return out(initWrite(root, answers, Boolean(flags.force)), flags);
      }
      throw new ForgeError('usage: forge init detect | forge init write --answers FILE [--force]');
    }
    case 'config': {
      if (!sub || sub === 'show') return out(config, { ...flags, pretty: true });
      if (sub === 'get') return out(getPath(config, rest[0] ?? '') ?? null, flags);
      if (sub === 'validate') {
        const problems = validateConfig(config, root);
        out({ ok: !problems.length, initialized, problems }, flags);
        if (problems.length) process.exitCode = 1;
        return;
      }
      throw new ForgeError('usage: forge config [show|get PATH|validate]');
    }
    case 'doctor':
      return out(await doctor(root, config, initialized), { ...flags, pretty: true });
    case 'status':
      needInit();
      return out(statusTable(root, Boolean(flags.all)), flags);
    case 'next': {
      needInit();
      const tracker = await loadTracker(root, config);
      const items = tracker.list(ctx, { ready: true, limit: Number(flags.limit ?? 20) });
      const item = items[0];
      if (!item) return out({ item: null }, flags);
      if (!flags.claim) return out({ item, more: items.length - 1 }, flags);
      return out(await startFromRef(root, config, tracker, item.ref, flags), flags);
    }
    case 'job':
      needInit();
      return out(await jobCmd(root, config, sub, rest, flags), flags);
    case 'worktree': {
      needInit();
      if (sub === 'create') return out(wt.createWorktree(root, config, req(rest[0], 'job id')), flags);
      if (sub === 'remove') return out(wt.removeWorktree(root, req(rest[0], 'job id'), { deleteBranch: Boolean(flags['delete-branch']), force: Boolean(flags.force) }), flags);
      if (sub === 'path') return out(loadJob(root, req(rest[0], 'job id')).worktree ?? '', flags);
      if (sub === 'prune') return out(run('git', ['worktree', 'prune', '-v'], { cwd: root }).stderr.trim() || 'nothing to prune', flags);
      throw new ForgeError('usage: forge worktree create|remove|path|prune <id>');
    }
    case 'run': {
      needInit();
      const id = req(sub, 'job id');
      const name = req(rest[0], 'command name');
      if (flags.background) return out(wt.startBackground(root, config, id, name), flags);
      const r = wt.runCommand(root, config, id, name, { tail: Number(flags.tail ?? 40) });
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'stop':
      return out({ stopped: wt.stopBackground(root, req(sub, 'job id')) }, flags);
    case 'verify': {
      needInit();
      const r = wt.verify(root, config, req(sub, 'job id'));
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'integrate': {
      needInit();
      const r = pr.integrate(root, config, req(sub, 'job id'), { strategy: flags.strategy });
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'pr': {
      needInit();
      const id = req(rest[0], 'job id');
      if (sub === 'find') return out(pr.findPr(root, config, id), flags);
      if (sub === 'open') return out(pr.openPr(root, config, id, { title: flags.title, draft: flags.draft === undefined ? undefined : Boolean(flags.draft) }), flags);
      if (sub === 'sync') return out(pr.syncPr(root, config, id), flags);
      if (sub === 'merge') return out(pr.mergePr(root, config, id), flags);
      throw new ForgeError('usage: forge pr find|open|sync|merge <id>');
    }
    case 'sync':
      needInit();
      return out(await syncAll(root, config), flags);
    case 'tracker':
      needInit();
      return out(await trackerCmd(root, config, sub, rest, flags), flags);
    case 'stats': {
      const s = computeStats(root, { since: flags.since, includeEvals: Boolean(flags['include-evals']) });
      return out(flags.json ? s : statsText(s), flags);
    }
    case 'roster':
      return out(roster(root, config), flags);
    case 'retro': {
      needInit();
      if (sub === 'due') return out(retroDue(root, config), flags);
      if (sub === 'prepare') return out(prepareRetro(root, config, req(rest[0], 'retro job id'), { since: flags.since }), flags);
      throw new ForgeError('usage: forge retro due | forge retro prepare <job> [--since DATE]');
    }
    case 'eval':
      needInit();
      return out(await evalCmd(root, config, sub, rest, flags), flags);
    case 'requests': {
      if (!sub || sub === 'list') return out(listRequests(root, { status: flags.all ? undefined : 'pending' }), flags);
      if (sub === 'add') return out(enqueue(root, config, { type: req(rest[0], 'type'), job: flags.job, text: flags.text, from: 'cli' }), flags);
      if (sub === 'ack') return out(ackRequest(root, req(rest[0], 'request id'), { status: flags.status ?? 'done', result: flags.result }), flags);
      throw new ForgeError('usage: forge requests [list|add TYPE|ack ID]');
    }
    case 'migrate':
      return out(migrate(root), flags);
    case 'dash':
      return dash(root, config, flags);
    default:
      throw new ForgeError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

/** @param {any} v @param {string} what @returns {string} */
function req(v, what) {
  if (v === undefined || v === null || v === '' || v === true) throw new ForgeError(`missing ${what}`);
  return String(v);
}

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
async function jobCmd(root, config, sub, rest, flags) {
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
      const round = Number(flags.round ?? job.round);
      const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : job.reviewers;
      if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
      const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn);
      if (v.complete) {
        setJob(root, job.id, { fields: { [`verdicts.${round}`]: Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict])) } });
        logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome });
      }
      if (flags.compact) return { round, complete: v.complete, outcome: v.outcome, reviewers: Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict])) };
      return v;
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
    default:
      throw new ForgeError('usage: forge job new|from-ref|list|show|get|set|claim|release|note|human|agent|round|verdicts|decision|progress|paths');
  }
}

/**
 * Absolute paths an agent prompt needs, so the orchestrator can hand them over verbatim.
 * @param {string} root @param {any} config @param {any} job
 */
function jobPaths(root, config, job) {
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
    reviewDir: path.join(dir, 'review', `round-${round}`),
    previousReviewDir: round > 1 ? path.join(dir, 'review', `round-${round - 1}`) : null,
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
function compactJob(root, job) {
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

/** @param {string} root @param {boolean} all */
function statusTable(root, all) {
  const jobs = listJobs(root).filter((j) => all || isActive(j));
  if (!jobs.length) return 'no active jobs';
  const rows = jobs.map((j) => {
    const p = progress(root, j.id);
    const st = j.state === 'waiting' ? `waiting:${j.waitingOn}` : j.state;
    return [j.id, j.stage, st, j.round ? `r${j.round}` : '-', p.total ? `${p.done}/${p.total}` : '-', j.pr?.number ? `#${j.pr.number}` : '-', j.owner?.session?.slice(0, 8) ?? '-'];
  });
  const head = ['job', 'stage', 'state', 'round', 'tasks', 'pr', 'session'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

/** @param {any} s */
function statsText(s) {
  const pct = (/** @type {number|null} */ x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const q = s.quality;
  const lines = [
    `jobs ${s.counts.total} (active ${s.counts.active}, done ${s.counts.done}, waiting ${s.counts.waiting}, cancelled ${s.counts.cancelled})`,
    `first-pass review ${pct(q.firstPassReviewRate)} · avg rounds ${q.avgRounds ?? '—'} · verify first-pass ${pct(q.verifyFirstPassRate)}`,
    `escalations ${pct(q.escalationRate)} · PRs with human feedback ${pct(q.humanFeedbackOnPrRate)} · human reworks ${q.humanReworks} · spec approved first try ${pct(q.specFirstApprovalRate)}`,
    `median to PR ${s.speed.medianMinutesToPr ?? '—'} min · median to done ${s.speed.medianMinutesToDone ?? '—'} min`,
    `tokens ${s.cost.totalTokens.toLocaleString()} · est. API cost $${s.cost.estCostUsd} · per job $${s.cost.avgCostPerJobUsd ?? '—'} · usage coverage ${s.cost.reportingCoverage.withUsage}/${s.cost.reportingCoverage.agentRuns} (exact ${s.cost.reportingCoverage.exact})`,
  ];
  const rv = Object.entries(s.reviewers);
  if (rv.length) lines.push('reviewers: ' + rv.map(([k, v]) => `${k} ${pct(/** @type {any} */ (v).changeRate)} changes`).join(' · '));
  return lines.join('\n');
}

/**
 * @param {string} root @param {any} config @param {import('./trackers/index.mjs').Tracker} tracker @param {string} ref @param {Record<string, any>} flags
 */
async function startFromRef(root, config, tracker, ref, flags) {
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
async function mirrorToTracker(root, config, job) {
  if (!job.source?.ref || job.kind === 'eval' || job.source.tracker !== config.tracker.kind) return;
  try {
    const tracker = await loadTracker(root, config);
    tracker.update({ root, config }, String(job.source.ref), job);
  } catch (e) {
    logEvent(root, job.id, 'tracker-error', { error: /** @type {Error} */ (e).message.slice(0, 300) });
  }
}

/** @param {string} root @param {any} config */
async function syncAll(root, config) {
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

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
async function trackerCmd(root, config, sub, rest, flags) {
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

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
async function evalCmd(root, config, sub, rest, flags) {
  switch (sub) {
    case 'list':
      return evals.listTasks(root).map(({ dir: _d, request: _r, ...t }) => t);
    case 'new':
      return evals.createTask(root, req(rest[0], 'name'), flags.title ?? rest[0], bodyFrom(flags) || req(flags.request, '--request or --body-file'));
    case 'mine':
      return evals.mineFromPr(root, config, Number(req(flags.pr, '--pr')), { name: flags.name, testPattern: flags['test-pattern'] });
    case 'start':
      return evals.startRun(root, config, { tasks: list(flags.tasks), tags: list(flags.tags), label: flags.label });
    case 'grade':
      return evals.gradeJob(root, config, req(rest[0], 'job id'));
    case 'runs':
      return evals.listRuns(root).map((r) => ({ id: r.id, label: r.label, status: r.status, configHash: r.configHash, forgeVersion: r.forgeVersion, summary: r.summary }));
    case 'report': {
      const r = evals.listRuns(root).find((x) => x.id === req(rest[0], 'run id'));
      if (!r) throw new ForgeError(`no run ${rest[0]}`);
      return r;
    }
    case 'compare':
      return evals.compareRuns(root, req(rest[0], 'run A'), req(rest[1], 'run B'));
    default:
      throw new ForgeError('usage: forge eval list|new|mine|start|grade|runs|report|compare');
  }
}

/** @param {string} root @param {any} answers @param {boolean} force */
function initWrite(root, answers, force) {
  const p = paths(root);
  if (exists(p.config) && !force) {
    const current = yaml.parse(readText(p.config)) ?? {};
    answers = deepMerge(current, answers);
  }
  const config = deepMerge(defaults(), answers);
  if (Array.isArray(answers?.review?.panel)) config.review.panel = answers.review.panel;
  const problems = validateConfig(config, root);
  if (problems.length) throw new ForgeError(`config would be invalid:\n- ${problems.join('\n- ')}`);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.config, stringifyConfig(config));
  const written = [path.relative(root, p.config)];
  const tpl = path.join(PLUGIN_ROOT, 'templates');
  /** @type {[string, string][]} */
  const seeds = [
    [path.join(tpl, 'gitignore'), path.join(p.dir, '.gitignore')],
    [path.join(tpl, 'learnings.md'), path.join(p.notes, 'learnings.md')],
    [path.join(tpl, 'README.md'), path.join(p.dir, 'README.md')],
  ];
  if (config.tracker.kind === 'local') seeds.push([path.join(tpl, 'backlog.md'), path.join(root, config.tracker.local.path)]);
  for (const [src, dst] of seeds) {
    if (exists(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    written.push(path.relative(root, dst));
  }
  return { ok: true, written };
}

/** @param {string} root @param {any} config @param {boolean} initialized */
async function doctor(root, config, initialized) {
  const checks = [];
  const add = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ detail = '') => checks.push({ name, ok, detail });
  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
  const gitV = run('git', ['--version'], { allowFail: true });
  add('git', gitV.ok, gitV.stdout.trim());
  const sparse = run('git', ['sparse-checkout', '-h'], { allowFail: true });
  add('git sparse-checkout (evals)', sparse.status === 129 || sparse.ok, '');
  add('config present', initialized, initialized ? path.relative(root, paths(root).config) : 'run /forge init');
  if (initialized) {
    const problems = validateConfig(config, root);
    add('config valid', !problems.length, problems.join('; '));
  }
  const needsGh = config.pr.enabled || config.tracker.kind === 'github';
  if (needsGh) {
    const auth = hasBinary('gh') ? run('gh', ['auth', 'status'], { allowFail: true }) : null;
    add('gh installed + authenticated', Boolean(auth?.ok), auth ? (auth.ok ? 'ok' : (auth.stderr || auth.stdout).trim().split('\n')[0]) : 'gh not found');
    if (auth?.ok && ['project', 'both'].includes(config.tracker.github.statusSync)) {
      const scopes = `${auth.stdout}${auth.stderr}`;
      add('gh token has "project" scope', /project/.test(scopes), 'run: gh auth refresh -s project');
    }
  }
  const remote = run('git', ['remote', 'get-url', config.git.remote], { cwd: root, allowFail: true });
  add(`remote "${config.git.remote}"`, remote.ok, remote.ok ? 'ok' : 'missing (PRs need a remote)');
  const base = run('git', ['rev-parse', '--verify', '--quiet', config.git.base], { cwd: root, allowFail: true });
  add(`base branch "${config.git.base}"`, base.ok, '');
  for (const j of listJobs(root).filter((x) => isActive(x) && x.port)) {
    if (j.worktree && !exists(j.worktree)) add(`job ${j.id} worktree`, false, `missing: ${j.worktree}`);
  }
  const unsupported = listJobs(root).filter((j) => /** @type {any} */ (j)._unsupported);
  if (unsupported.length) add('job schema', false, `${unsupported.length} job(s) from a newer Forge`);
  return { ok: checks.every((c) => c.ok), checks };
}

/** @param {string} root */
function migrate(root) {
  const p = paths(root);
  const changed = [];
  if (exists(p.config)) {
    const raw = yaml.parse(readText(p.config)) ?? {};
    const m = migrateConfig(raw);
    if (m.from !== undefined) {
      fs.writeFileSync(p.config, stringifyConfig(m.config));
      changed.push(path.relative(root, p.config));
    }
  }
  for (const j of listJobs(root)) {
    const file = path.join(jobDir(root, j.id), 'job.json');
    const raw = readJson(file);
    const next = serializeJob(normalizeJob(raw));
    if (JSON.stringify(raw) !== JSON.stringify(next)) {
      writeJsonAtomic(file, next);
      changed.push(path.relative(root, file));
    }
  }
  return { changed };
}

/** @param {string} root @param {any} config @param {Record<string, any>} flags */
async function dash(root, config, flags) {
  const rtFile = path.join(paths(root).runtime, 'dashboard.json');
  const current = readJson(rtFile, null);
  const alive = current?.pid && (() => {
    try {
      process.kill(current.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (flags.stop) {
    if (alive) process.kill(current.pid, 'SIGTERM');
    writeJsonAtomic(rtFile, {});
    return out({ stopped: Boolean(alive) }, flags);
  }
  if (alive && !flags.foreground) return out({ url: current.url, pid: current.pid, running: true }, flags);
  const port = Number(flags.port ?? config.dashboard.port ?? 7400);
  if (flags.background) {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'dash', '--foreground', '--port', String(port)], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      const rt = readJson(rtFile, null);
      if (rt?.pid === child.pid) return out({ url: rt.url, pid: child.pid, started: true }, flags);
      sleepSync(50);
    }
    return out({ url: `http://127.0.0.1:${port}`, pid: child.pid, started: true, unconfirmed: true }, flags);
  }
  const { startServer } = await import('./server.mjs');
  let res;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer(root, { port: p });
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!res) throw new ForgeError(`no free port near ${port}`);
  writeJsonAtomic(rtFile, { pid: process.pid, url: res.url, startedAt: new Date().toISOString() });
  process.stdout.write(`forge dashboard: ${res.url}\n`);
}
