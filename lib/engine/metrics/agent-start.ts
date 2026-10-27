// Seconds from an agent run's start to its first tool call, read from the head of its Claude Code
// transcript for forge stats; bounded, and null-safe where transcripts are gone.
import fs from 'node:fs';
import { AGENT_ID, agentTranscriptById, claudeProjectsDir, firstToolCallAt, openTranscript } from '#integrations/claude/transcripts.ts';
import { jobSpeed, spread } from './speed.ts';
import type { StatsSource } from './types.ts';
import type { Job, Stats } from '#core/types.ts';

/** The most transcripts one call reads, newest runs first. */
const MAX_RUNS = 200;

/**
 * Foreground and background spreads of the seconds from each done job's agent-start to its transcript's
 * first tool call. Transcripts are found only through agentTranscriptById (a valid agent id, this
 * repo's project dirs, confined) and opened through openTranscript; a run without one is left out.
 * Only numbers leave this function.
 */
export function agentStartSeconds(
  root: string,
  sources: StatsSource[],
  opts: { projects?: string; worktrees?: string; maxRuns?: number } = {},
): Stats['speed']['agentStartSeconds'] {
  const projects = opts.projects ?? claudeProjectsDir();
  const runs: { job: Job; agentId: string; start: number; background: boolean }[] = [];
  for (const src of sources) {
    const speed = jobSpeed(src.job, src.events());
    if (!speed) continue;
    for (const r of speed.runs) if (r.agentId !== null && AGENT_ID.test(r.agentId)) runs.push({ job: src.job, agentId: r.agentId, start: r.start, background: r.background });
  }
  runs.sort((a, b) => b.start - a.start);
  const foreground: number[] = [];
  const background: number[] = [];
  for (const r of runs.slice(0, opts.maxRuns ?? MAX_RUNS)) {
    const hit = agentTranscriptById(root, r.job, r.agentId, { projects, worktrees: opts.worktrees });
    const t = hit ? openTranscript(hit, projects) : null;
    if (!t) continue;
    let at: number | null = null;
    try {
      at = firstToolCallAt(t.fd, t.size, r.start);
    } catch {
      // An unreadable transcript is left out, never an error.
    } finally {
      fs.closeSync(t.fd);
    }
    if (at !== null && at >= r.start) (r.background ? background : foreground).push((at - r.start) / 1000);
  }
  return { foreground: spread(foreground, 1), background: spread(background, 1) };
}
