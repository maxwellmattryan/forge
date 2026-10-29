// Human-readable summaries: `forge status` and the text form of `forge stats`.
import { foremanHandoffFor } from '#office/foreman/policy.ts';
import { isActive, listJobs, progress } from '#core/job/store.ts';
import type { Job, Stats, TimeSpread } from '#core/types.ts';
import type { HelpGroup, StatusRow } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'status',
    summary: 'active jobs at a glance',
    commands: [{ command: 'status', args: '[--all]', summary: 'active jobs at a glance: a text table, or with --json one row per job', flags: [['--all', 'include finished and cancelled jobs']] }],
  },
  {
    name: 'stats',
    summary: 'pipeline metrics: quality, speed and cost',
    commands: [
      {
        command: 'stats',
        args: '[--since DATE] [--include-evals] [--json] | --by prompt [--role R] [--since DATE] [--include-evals] | --csv [--since DATE] [--by job|role|model|day] | --mandate <id>',
        summary:
          'pipeline metrics: review and verify first-pass rates, per-lens change, dispute and miss rates, blockers, sole-CHANGES and reopened counts, recurring, carried and new findings, escalations, time to PR, working minutes by stage, parked minutes, time between agents, stalls, agent gaps, agent start and extra-round time, tokens, cost and cache-read share (a text summary, or the full object with --json); --by prompt groups jobs into prompt cohorts; --mandate prints one mandate\'s live report card',
        flags: [
          ['--since DATE', 'only jobs created on or after DATE'],
          ['--include-evals', 'count eval jobs too (--csv always counts every job)'],
          ['--csv', 'spend as RFC 4180 CSV with CRLF line ends: key columns, a source column (reported, supervisor, or session-usage, which the supervisor rows already count), then runs,tokens,input,output,cache_read,cache_write,usd; with it, --since keeps events at or after DATE'],
          ['--by K', 'with --csv: one row per job (default, keyed job,kind,title), role, model or day; `prompt` (JSON only): one cohort per prompt hash the role last started on, each with its own stats'],
          ['--role R', 'with --by prompt: the agents/*.md role or reviewer:<lens> whose starts key the cohorts (default builder)'],
          ['--mandate ID', "the mandate's report card as JSON, computed live (any status): what merged, scores, review rounds, interventions by gate, spend against budget and outcomes, a figure still awaiting a score run or outcome window reading pending; takes no other stats flag"],
        ],
        docs: ['Repo budget', 'docs/CLI.md#repo-budget'],
      },
    ],
  },
];

/** `forge status --json`: one row per job, the data `forge status` prints as a table. */
export function statusRows(root: string, all: boolean): StatusRow[] {
  return activeJobs(root, all).map((j) => statusRow(root, j));
}

const isShelved = (j: Pick<Job, 'state' | 'waitingOn'>): boolean => j.state === 'waiting' && j.waitingOn === 'shelved';

/** listJobs' order, with shelved jobs after every other: set aside, they wait on nobody. */
const activeJobs = (root: string, all: boolean): Job[] => {
  const jobs = listJobs(root).filter((j) => all || isActive(j));
  return [...jobs.filter((j) => !isShelved(j)), ...jobs.filter(isShelved)];
};

function statusRow(root: string, j: Job): StatusRow {
  const p = progress(root, j.id);
  const shelved = isShelved(j) && j.shelved ? { at: j.shelved.at, reason: j.shelved.reason } : null;
  // foremanHandoffFor reads events only for a waiting job.
  return { id: j.id, stage: j.stage, state: j.state, waitingOn: j.waitingOn, round: j.round, tasks: { done: p.done, total: p.total }, pr: j.pr?.number ?? null, session: j.lease.driver, foremanHandoff: foremanHandoffFor(root, j), shelved };
}

export function statusTable(root: string, all: boolean): string {
  const jobs = statusRows(root, all);
  if (!jobs.length) return 'no active jobs';
  const rows = jobs.map((j) => {
    const st = isShelved(j) ? 'shelved' : j.state === 'waiting' ? `waiting:${j.waitingOn}${j.foremanHandoff ? ' (left for a human)' : ''}` : j.state;
    return [j.id, j.stage, st, j.round ? `r${j.round}` : '-', j.tasks.total ? `${j.tasks.done}/${j.tasks.total}` : '-', j.pr ? `#${j.pr}` : '-', j.session?.slice(0, 8) ?? '-'];
  });
  const head = ['job', 'stage', 'state', 'round', 'tasks', 'pr', 'session'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

/** A status row plus the job's reason and its Foreman hand-off as one line: what human mode's `forge status` renders. */
export type StatusView = Omit<StatusRow, 'foremanHandoff'> & { reason: string | null; handoff: string | null };

/** `forge status` in human mode: statusRows with each job's reason and `<class>: <reason>` for a hand-off. */
export function statusView(root: string, all: boolean): StatusView[] {
  return activeJobs(root, all).map((j) => {
    const { foremanHandoff: h, ...row } = statusRow(root, j);
    return { ...row, reason: j.reason ?? null, handoff: h ? `${h.class}: ${h.reason}` : null };
  });
}

/** The stats summary's lines by section, with one [name, text] entry per reviewer and verifier. */
export interface StatsSections {
  jobs: string[];
  quality: string[];
  speed: string[];
  cost: string[];
  reviewers: [string, string][];
  verifiers: [string, string][];
}

export function statsSections(s: Stats): StatsSections {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const q = s.quality;
  // An older stats.json (or /api/stats) has none of the review and timing figures below.
  const sp: Partial<Stats['speed']> = s.speed;
  const spread = (x: TimeSpread | undefined, unit: string) => (x?.n ? `${x.median}${unit} (p90 ${x.p90}${unit}, n ${x.n})` : '—');
  const keyed = (rec: Record<string, number> | undefined) => Object.entries(rec ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const gaps = sp.handoffSeconds;
  const extra = sp.minutesPerExtraRound;
  const shares = Object.entries(s.cost.byRole ?? {}).flatMap(([k, v]) => (typeof v.cacheReadShare === 'number' ? [`${k} ${pct(v.cacheReadShare)}`] : []));
  const orch = s.cost.orchestrator;
  return {
    // An older stats.json (or /api/stats) has no shelved count.
    jobs: [`jobs ${s.counts.total}${s.counts.archived ? ` (${s.counts.archived} archived)` : ''} (active ${s.counts.active}, done ${s.counts.done}, waiting ${s.counts.waiting}, shelved ${s.counts.shelved ?? 0}, cancelled ${s.counts.cancelled})`],
    quality: [
      // An older stats.json (or /api/stats) has no outcome fields.
      `autonomy ${pct(q.autonomyRate ?? null)} (strict ${pct(q.autonomyRateStrict ?? null)}) · reverted ${pct(q.revertRate ?? null)} · follow-ups ${pct(q.followUpRate ?? null)} · churn ${pct(q.churnRate ?? null)} · outcomes final ${q.outcomeCoverage?.final ?? 0}/${q.outcomeCoverage?.merged ?? 0} (open ${q.outcomeCoverage?.open ?? 0})`,
      // An older stats.json (or /api/stats) has no score fields either.
      `score median ${typeof q.medianScore === 'number' ? `${q.medianScore}/5` : '-'} · scored ${q.scoreCoverage?.scored ?? 0}/${q.scoreCoverage?.sampled ?? 0} sampled (held ${q.scoreCoverage?.held ?? 0}, failed ${q.scoreCoverage?.failed ?? 0})`,
      `first-pass review ${pct(q.firstPassReviewRate)} · avg rounds ${q.avgRounds ?? '—'} · verify first-pass ${pct(q.verifyFirstPassRate)} · recurring findings ${q.recurringFindings} · rounds 2+ findings carried ${q.findingsCarried ?? 0}, new ${q.findingsNew ?? 0}`,
      `escalations ${pct(q.escalationRate)} · PRs with human feedback ${pct(q.humanFeedbackOnPrRate)} · human reworks ${q.humanReworks} · spec approved first try ${pct(q.specFirstApprovalRate)}`,
      `human delta after push ${pct(q.humanDeltaRate ?? null)} · median ${q.medianHumanDeltaLines ?? '—'} lines · measured ${q.humanDeltaCoverage?.measured ?? 0}/${q.humanDeltaCoverage?.merged ?? 0}`,
    ],
    speed: [
      `median to PR ${s.speed.medianMinutesToPr ?? '—'} min · median to done ${s.speed.medianMinutesToDone ?? '—'} min`,
      `working minutes by stage (median over ${sp.timedJobs ?? 0} done jobs) ${keyed(sp.stageMinutes)}`,
      `parked minutes (median) ${keyed(sp.waitingMinutes)}`,
      `between agents ${sp.medianHandoffMinutes ?? '—'} min/job · stalled ${sp.stalledMinutes ?? '—'} min/job · agent gaps ${spread(gaps?.withoutCommand, 's')} without a command, ${spread(gaps?.withCommand, 's')} with one`,
      `agent start ${spread(sp.agentStartSeconds?.foreground, 's')} foreground, ${spread(sp.agentStartSeconds?.background, 's')} background · extra round ${extra?.n ? `${extra.median} min (p90 ${extra.p90})` : '—'}`,
    ],
    cost: [
      `tokens ${s.cost.totalTokens.toLocaleString()} · est. API cost $${s.cost.estCostUsd} · per job $${s.cost.avgCostPerJobUsd ?? '—'} · usage coverage ${s.cost.reportingCoverage.withUsage}/${s.cost.reportingCoverage.agentRuns} (exact ${s.cost.reportingCoverage.exact})`,
      ...(shares.length ? [`cache-read share ${shares.join(' · ')}`] : []),
      // An older stats.json (or /api/stats) has no orchestrator figure.
      ...(orch
        ? [`orchestrator $${orch.estCostUsd} (job $${orch.byLane.job.estCostUsd} · inbox $${orch.byLane.inbox.estCostUsd} · office $${orch.byLane.office.estCostUsd}) · ${orch.turns} turns · session usage on ${orch.coverage.withUsage}/${orch.coverage.jobs} jobs`]
        : []),
    ],
    // An older stats.json (or /api/stats) has no miss rate, sole or reopened counts.
    reviewers: Object.entries(s.reviewers).map(([k, v]) => [
      k,
      `${pct(v.changeRate)} changes, ${v.blockers ?? 0} blockers, sole ${v.soleChanges ?? 0}, reopened ${v.reopened ?? 0}, ${pct(v.disputeRate)} disputed, ${pct(v.missRate ?? null)} missed`,
    ]),
    // An older stats.json (or /api/stats) has no verifiers.
    verifiers: Object.entries(s.verifiers ?? {}).map(([k, v]) => [k, `${pct(v.hitRate)} hit over ${v.runs} runs, ${v.blocks} blocked`]),
  };
}

export function statsText(s: Stats): string {
  const x = statsSections(s);
  const lines = [...x.jobs, ...x.quality, ...x.speed, ...x.cost];
  const joined = (entries: [string, string][]) => entries.map(([k, v]) => `${k} ${v}`).join(' · ');
  if (x.reviewers.length) lines.push('reviewers: ' + joined(x.reviewers));
  if (x.verifiers.length) lines.push('verifiers: ' + joined(x.verifiers));
  return lines.join('\n');
}
