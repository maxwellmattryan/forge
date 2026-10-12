// @ts-check
// Assembles the retro agent's inputs deterministically, so the expensive model spends its
// context on judgement rather than on trawling job folders.
import fs from 'node:fs';
import path from 'node:path';
import { listJobs, readEvents, jobDir } from './jobs.mjs';
import { listRuns } from './evals.mjs';
import { paths, exists } from './paths.mjs';
import { computeStats } from './stats.mjs';
import { readText, writeJsonAtomic } from './util.mjs';

/** @param {string} root */
export function lastRetro(root) {
  return listJobs(root)
    .filter((j) => j.kind === 'retro')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

/** @param {string} root @param {any} config */
export function retroDue(root, config) {
  const last = lastRetro(root);
  const since = last?.createdAt ?? null;
  const finished = listJobs(root).filter(
    (j) => !['eval', 'retro'].includes(j.kind) && ['done', 'cancelled'].includes(j.state) && (!since || String(j.finishedAt ?? j.updatedAt) > since),
  ).length;
  return { due: finished >= (config.improve?.retroEvery ?? 10), finishedSinceLast: finished, every: config.improve?.retroEvery ?? 10, lastRetro: last?.id ?? null };
}

/** @param {string} text @param {number} n */
const head = (text, n) => text.split('\n').slice(0, n).join('\n').trim();

/**
 * @param {string} root @param {any} config @param {string} retroJobId @param {{since?:string}} [opts]
 */
export function prepareRetro(root, config, retroJobId, opts = {}) {
  const since = opts.since ?? lastRetro(root)?.createdAt ?? undefined;
  const stats = computeStats(root, { since });
  const dir = jobDir(root, retroJobId);
  writeJsonAtomic(path.join(dir, 'stats.json'), stats);
  const jobs = listJobs(root).filter((j) => !['eval', 'retro'].includes(j.kind) && (!since || String(j.createdAt) >= since));
  const out = [`# Signals since ${since ?? 'the beginning'}`, '', `${jobs.length} job(s) in window.`, ''];
  for (const j of jobs) {
    const jd = jobDir(root, j.id);
    const events = readEvents(root, j.id);
    const lines = [];
    for (const e of events) {
      if (e.type === 'human') lines.push(`- human **${e.action}**${e.note ? `: ${String(e.note).slice(0, 400)}` : ''}`);
      if (e.type === 'command' && !e.ok && /^verify-/.test(e.name ?? '')) lines.push(`- verify step failed: ${e.name}`);
      if (e.type === 'integrate-conflicts') lines.push(`- merge conflicts in: ${(e.conflicts ?? []).join(', ')}`);
    }
    for (const r of Object.keys(j.verify ?? {})) if (j.verify[r] === 'FAIL') lines.push(`- verify FAIL in round ${r}`);
    for (const [round, v] of Object.entries(j.verdicts ?? {})) {
      for (const [lens, verdict] of Object.entries(v ?? {})) {
        if (verdict === 'MALFORMED') lines.push(`- reviewer ${lens} wrote a malformed review (round ${round})`);
        if (verdict === 'CHANGES') {
          const file = path.join(jd, 'review', `round-${round}`, `${lens}.md`);
          const findings = readText(file).split('\n').filter((l) => /^\s*[-*]\s*\[(blocker|major)\]/i.test(l)).slice(0, 4);
          for (const f of findings) lines.push(`- r${round} ${lens}: ${f.trim().slice(0, 300)}`);
        }
      }
    }
    if (j.decision === 'ESCALATE') lines.push(`- escalated: ${head(readText(path.join(jd, 'decision.md')), 1)}`);
    const fb = readText(path.join(jd, 'pr-feedback.md'));
    if (fb && !fb.includes('No outstanding human feedback')) lines.push(`- PR feedback:\n${head(fb.replace(/^# .*\n/, ''), 20).replace(/^/gm, '  ')}`);
    const questions = readText(path.join(jd, 'questions.md'));
    if (questions) lines.push(`- asked the human:\n${head(questions, 8).replace(/^/gm, '  ')}`);
    if (!lines.length) continue;
    out.push(`## ${j.id} (${j.state}, rounds ${Object.keys(j.verdicts ?? {}).length}, ${j.usage?.totalTokens ?? 0} tokens)`, ...lines, '');
  }
  const runs = listRuns(root).slice(0, 5);
  if (runs.length) {
    out.push('## Recent eval runs', '');
    for (const r of runs) out.push(`- ${r.id} (config ${r.configHash}, v${r.forgeVersion}): ${JSON.stringify(r.summary)}`);
  }
  fs.writeFileSync(path.join(dir, 'signals.md'), out.join('\n') + '\n');
  const experiments = path.join(paths(root).notes, 'experiments.md');
  return {
    stats: path.join(dir, 'stats.json'),
    signals: path.join(dir, 'signals.md'),
    experiments: exists(experiments) ? experiments : null,
    jobsInWindow: jobs.length,
    since: since ?? null,
  };
}
