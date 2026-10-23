// `forge job agent start|end|attach`: recording an agent's run, its usage and the secret scan of what it wrote.
import fs from 'node:fs';
import path from 'node:path';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { refuseInboxDrive } from '#office/owner.ts';
import { AGENT_LEASE_MS, agentOutputMissing, attachAgent, checkFence, importCursor, jobDir, loadJob, recordAgent, renewLease, resolveAgentOutput } from '#core/job/store.ts';
import { logSecrets, scanAgentOutputs } from '#engine/guard/secrets.ts';
import { AGENT_ID } from '#integrations/claude/transcripts.ts';
import { importClaudeCodeTranscript } from '#engine/metrics/usage.ts';
import { ForgeError } from '#core/errors.ts';
import type { AgentUsage, Config } from '#core/types.ts';
import { num, req, requireJob, str } from '../args.ts';
import { epochFence } from './lease.ts';

export function agent(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  const phase = req(rest[1], 'start|end|attach');
  if (!['start', 'end', 'attach'].includes(phase)) throw new ForgeError('phase must be start, end or attach', 'usage');
  const role = req(flags.role, '--role');
  if (phase === 'attach') {
    const agentId = flags['agent-id'];
    // Checked before anything is written: the id becomes a transcript file name.
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new ForgeError('--agent-id must match [A-Za-z0-9_-]{1,100}', 'usage');
    const a = attachAgent(root, jobId, role, agentId).agents[role];
    return { role, status: a.status, agentId: a.agentId };
  }
  // Validated before anything is written, so a bad count leaves job.json and its usage untouched.
  const summary = str(flags.summary, '--summary');
  const tokens = num(flags.tokens, '--tokens');
  const toolUses = num(flags['tool-uses'], '--tool-uses');
  const durationMs = num(flags['duration-ms'], '--duration-ms');
  // `end` stays allowed, so a stray start can still be closed.
  if (phase === 'start') refuseInboxDrive(jobId);
  // Before the output dir, the secret scan's event and the import: a stale driver leaves no trace.
  const fence = epochFence(flags);
  if (fence) checkFence(root, jobId, fence);
  let usage: (AgentUsage & { transcript?: string; through?: string | null }) | undefined;
  let since: string | null = null;
  let output: string | null = null;
  let outputMissing: boolean | null = null;
  if (phase === 'start' && flags.output !== undefined) {
    if (typeof flags.output !== 'string' || !flags.output) throw new ForgeError('--output needs a path');
    // Resolved and checked before anything is written, so a refused path leaves no trace.
    output = resolveAgentOutput(root, jobId, flags.output);
    fs.mkdirSync(path.dirname(path.join(jobDir(root, jobId), output)), { recursive: true });
  }
  let secrets = 0;
  if (phase === 'end') {
    const before = loadJob(root, jobId);
    outputMissing = agentOutputMissing(root, before.id, role, before.agents[role], summary);
    // Detection only: what the agent wrote stays in the job dir, but a human sees the note.
    const scan = scanAgentOutputs(root, config, before, role);
    logSecrets(root, before.id, 'agent-end', scan, { blocked: false, role });
    secrets = scan.findings.length;
    if (flags.import && flags['agent-id']) {
      since = importCursor(before, String(flags['agent-id']));
      usage = importClaudeCodeTranscript(String(flags['agent-id']), { since, root, job: before }) ?? undefined;
    }
    if (!usage && (tokens !== undefined || toolUses !== undefined || durationMs !== undefined)) usage = { totalTokens: tokens ?? 0, toolUses: toolUses ?? 0, durationMs: durationMs ?? 0 };
    if (usage && !usage.toolUses && toolUses) usage.toolUses = toolUses;
  }
  const job = recordAgent(
    root,
    jobId,
    {
      role,
      phase: phase as 'start' | 'end',
      model: flags.model ?? usage?.model ?? undefined,
      agentId: flags['agent-id'],
      status: flags.status,
      summary,
      // The transcript's path and cursor are set to undefined, so the usage job.json records is
      // only token counts; the cursor goes to the agent record instead.
      usage: usage ? ({ ...usage, transcript: undefined, through: undefined } as AgentUsage) : undefined,
      importedThrough: usage?.through,
      ...(phase === 'start' ? { output, retry: flags.retry === true } : {}),
      ...(outputMissing !== null ? { outputMissing } : {}),
    },
    config,
    fence,
  );
  // The driver's agents are its activity: a start keeps the lease for the longest agent run, an end for the usual span.
  renewLease(root, jobId, { ttl: phase === 'start' ? AGENT_LEASE_MS : undefined });
  const a = job.agents[role];
  const budget = phase === 'end' ? enforceBudget(root, config, job.id, 'agent-end') : null;
  return { role, status: a.status, model: a.model, usage: usage ? { tokens: usage.totalTokens, exact: Boolean(usage.exact), ...(since && usage.transcript ? { since } : {}) } : null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd, ...(outputMissing !== null ? { outputMissing } : {}), ...(secrets ? { secrets } : {}), ...(budget ? { budget } : {}) };
}
