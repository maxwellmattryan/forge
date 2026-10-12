// @ts-check
// Human-readable summaries: `forge status` and the text form of `forge stats`.
import { isActive, listJobs, progress } from '../jobs.mjs';

/** @param {string} root @param {boolean} all */
export function statusTable(root, all) {
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
export function statsText(s) {
  const pct = (/** @type {number|null} */ x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
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
  if (rv.length) lines.push('reviewers: ' + rv.map(([k, v]) => `${k} ${pct(/** @type {any} */ (v).changeRate)} changes`).join(' · '));
  return lines.join('\n');
}
