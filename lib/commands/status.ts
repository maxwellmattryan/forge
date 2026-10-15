// Human-readable summaries: `forge status` and the text form of `forge stats`.
import { isActive, listJobs, progress } from '../jobs.ts';
import type { HelpGroup, Stats, StatusRow } from '../types.ts';

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
        args: '[--since DATE] [--include-evals] [--json]',
        summary: 'pipeline metrics: review and verify first-pass rates, escalations, time to PR, tokens and cost (a text summary, or the full object with --json)',
        flags: [
          ['--since DATE', 'only jobs created on or after DATE'],
          ['--include-evals', 'count eval jobs too'],
        ],
      },
    ],
  },
];

/** `forge status --json`: one row per job, the data `forge status` prints as a table. */
export function statusRows(root: string, all: boolean): StatusRow[] {
  return listJobs(root)
    .filter((j) => all || isActive(j))
    .map((j) => {
      const p = progress(root, j.id);
      return { id: j.id, stage: j.stage, state: j.state, waitingOn: j.waitingOn, round: j.round, tasks: { done: p.done, total: p.total }, pr: j.pr?.number ?? null, session: j.owner?.session ?? null };
    });
}

export function statusTable(root: string, all: boolean): string {
  const jobs = statusRows(root, all);
  if (!jobs.length) return 'no active jobs';
  const rows = jobs.map((j) => {
    const st = j.state === 'waiting' ? `waiting:${j.waitingOn}` : j.state;
    return [j.id, j.stage, st, j.round ? `r${j.round}` : '-', j.tasks.total ? `${j.tasks.done}/${j.tasks.total}` : '-', j.pr ? `#${j.pr}` : '-', j.session?.slice(0, 8) ?? '-'];
  });
  const head = ['job', 'stage', 'state', 'round', 'tasks', 'pr', 'session'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

export function statsText(s: Stats): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const q = s.quality;
  const lines = [
    `jobs ${s.counts.total} (active ${s.counts.active}, done ${s.counts.done}, waiting ${s.counts.waiting}, cancelled ${s.counts.cancelled})`,
    `first-pass review ${pct(q.firstPassReviewRate)} · avg rounds ${q.avgRounds ?? '—'} · verify first-pass ${pct(q.verifyFirstPassRate)}`,
    `escalations ${pct(q.escalationRate)} · PRs with human feedback ${pct(q.humanFeedbackOnPrRate)} · human reworks ${q.humanReworks} · spec approved first try ${pct(q.specFirstApprovalRate)}`,
    `human delta after push ${pct(q.humanDeltaRate ?? null)} · median ${q.medianHumanDeltaLines ?? '—'} lines · measured ${q.humanDeltaCoverage?.measured ?? 0}/${q.humanDeltaCoverage?.merged ?? 0}`,
    `median to PR ${s.speed.medianMinutesToPr ?? '—'} min · median to done ${s.speed.medianMinutesToDone ?? '—'} min`,
    `tokens ${s.cost.totalTokens.toLocaleString()} · est. API cost $${s.cost.estCostUsd} · per job $${s.cost.avgCostPerJobUsd ?? '—'} · usage coverage ${s.cost.reportingCoverage.withUsage}/${s.cost.reportingCoverage.agentRuns} (exact ${s.cost.reportingCoverage.exact})`,
  ];
  const rv = Object.entries(s.reviewers);
  if (rv.length) lines.push('reviewers: ' + rv.map(([k, v]) => `${k} ${pct(v.changeRate)} changes`).join(' · '));
  return lines.join('\n');
}
