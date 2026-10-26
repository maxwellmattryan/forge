// `forge job agent start|end|attach`: recording an agent's run, its usage and the secret scan of what it wrote.
import fs from 'node:fs';
import path from 'node:path';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { refuseInboxDrive } from '#office/owner.ts';
import { AGENT_LEASE_MS, agentOutputMissing, attachAgent, checkFence, importCursor, jobDir, loadJob, recordAgent, renewLease, resolveAgentOutput, type Fence } from '#core/job/store.ts';
import { logSecrets, scanAgentOutputs } from '#engine/guard/secrets.ts';
import { AGENT_ID } from '#integrations/claude/transcripts.ts';
import { importClaudeCodeTranscript } from '#engine/metrics/usage.ts';
import { ForgeError } from '#core/errors.ts';
import { agentRole } from '#core/job/lens.ts';
import { daemonScope } from '#core/job/requests.ts';
import type { AgentUsage, Config } from '#core/types.ts';
import { num, req, requireJob, str } from '../args.ts';
import { epochFence } from './lease.ts';

/** Usage with the transcript import's own fields, which job.json never records. */
type ImportedUsage = AgentUsage & { transcript?: string; through?: string | null };

/**
 * In a daemon session an agent's end is measured, never self-reported: its counts are refused, its transcript is always
 * imported (the agent id from --agent-id or the role's record), and an end inside the job's own session is marked
 * `metered`, since that session's meter already holds its cost (docs/architecture/policies.md "Usage accounting").
 */
export function agent(root: string, config: Config, rest: string[], flags: Record<string, any>, env: NodeJS.ProcessEnv = process.env) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  const phase = req(rest[1], 'start|end|attach');
  if (!['start', 'end', 'attach'].includes(phase)) throw new ForgeError('phase must be start, end or attach', 'usage');
  // A job.json key and an output path: checked before anything is read or written.
  const role = agentRole(req(flags.role, '--role'));
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
  const agentId: string | undefined = flags['agent-id'];
  if (phase === 'end') return endAgent(root, config, jobId, { role, model: flags.model, status: flags.status, summary, agentId, tokens, toolUses, durationMs, import: Boolean(flags.import), env, fence: epochFence(flags) });
  // `end` stays allowed, so a stray start can still be closed.
  refuseInboxDrive(jobId);
  return startAgent(root, config, jobId, { role, model: flags.model, output: flags.output, retry: flags.retry === true, agentId, status: flags.status, summary, fence: epochFence(flags) });
}

/**
 * An agent's start: the output path resolved inside the job dir, the record and its event, and the lease kept
 * for the longest agent run. The caller has refused the inbox, office and assistant scopes (refuseInboxDrive)
 * and checked the role. With `fence`, its epoch and its check run under the job lock before any write.
 */
export function startAgent(
  root: string,
  config: Config,
  jobId: string,
  o: { role: string; model?: string; output?: unknown; retry?: boolean; agentId?: string; status?: string; summary?: string; fence?: Fence },
) {
  // Before the output dir: a stale driver leaves no trace.
  if (o.fence) checkFence(root, jobId, o.fence);
  let output: string | null = null;
  if (o.output !== undefined) {
    if (typeof o.output !== 'string' || !o.output) throw new ForgeError('--output needs a path');
    // Resolved and checked before anything is written, so a refused path leaves no trace.
    output = resolveAgentOutput(root, jobId, o.output);
    fs.mkdirSync(path.dirname(path.join(jobDir(root, jobId), output)), { recursive: true });
  }
  const job = recordAgent(root, jobId, { role: o.role, phase: 'start', model: o.model, agentId: o.agentId, status: o.status, summary: o.summary, output, retry: o.retry === true }, config, o.fence);
  // The driver's agents are its activity: a start keeps the lease for the longest agent run.
  renewLease(root, jobId, { ttl: AGENT_LEASE_MS });
  const a = job.agents[o.role];
  return { role: o.role, status: a.status, model: a.model, usage: null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd };
}

/**
 * An agent's end: the output check, the secret scan of what it wrote, its usage, the record and its event, the
 * lease renewal and the budget check. `usage` supplied is a role run's own measure (`forge job agent run`): no
 * transcript import, none of the daemon refusals, never `metered`, and recorded as given (`null`: none, and
 * `unmeasured` when the run said so). No flag reaches that path. With `fence`, its epoch runs under the job lock
 * before any write.
 */
export function endAgent(
  root: string,
  config: Config,
  jobId: string,
  o: {
    role: string;
    model?: string;
    status?: string;
    summary?: string;
    agentId?: string;
    tokens?: number;
    toolUses?: number;
    durationMs?: number;
    import?: boolean;
    usage?: ImportedUsage | null;
    /** With `usage` supplied: the run's usage could not be measured at all. */
    unmeasured?: boolean;
    env: NodeJS.ProcessEnv;
    fence?: Fence;
  },
) {
  const { role, summary, tokens, toolUses, durationMs, env, fence } = o;
  const measured = o.usage !== undefined;
  // A malformed scope still runs under the daemon: it gets the refusals, never the `metered` mark.
  const ds = daemonScope(env);
  const daemon = !measured && ('problem' in ds || ds.daemon);
  let agentId = o.agentId;
  if (daemon) {
    if (tokens !== undefined || toolUses !== undefined || durationMs !== undefined)
      throw new ForgeError("forge job agent end refuses --tokens, --tool-uses and --duration-ms in a daemon session: pass --agent-id and Forge reads the agent's transcript", 'usage');
    agentId ??= loadJob(root, jobId).agents[role]?.agentId ?? undefined;
    if (agentId === undefined && o.status !== 'lost')
      throw new ForgeError('forge job agent end needs --agent-id in a daemon session (the id the Agent tool returned); end an agent that never started with --status lost', 'usage');
    // Checked before anything is written: the id becomes a transcript file name.
    if (agentId !== undefined && (typeof agentId !== 'string' || !AGENT_ID.test(agentId))) throw new ForgeError('--agent-id must match [A-Za-z0-9_-]{1,100}', 'usage');
  }
  const metered = !measured && 'scope' in ds && ds.daemon && ds.scope === jobId;
  let unmeasured = measured && o.unmeasured === true;
  // Before the secret scan's event and the import: a stale driver leaves no trace.
  if (fence) checkFence(root, jobId, fence);
  let usage: ImportedUsage | undefined = o.usage ?? undefined;
  let since: string | null = null;
  const before = loadJob(root, jobId);
  const outputMissing = agentOutputMissing(root, before.id, role, before.agents[role], summary);
  // Detection only: what the agent wrote stays in the job dir, but a human sees the note.
  const scan = scanAgentOutputs(root, config, before, role);
  logSecrets(root, before.id, 'agent-end', scan, { blocked: false, role });
  const secrets = scan.findings.length;
  if (!measured && agentId && (o.import || daemon)) {
    since = importCursor(before, String(agentId));
    usage = importClaudeCodeTranscript(String(agentId), { since, root, job: before }) ?? undefined;
    // A background agent's transcript can lag its end: the end is recorded, never held for it.
    unmeasured = daemon && !usage;
  }
  if (!measured && !usage && (tokens !== undefined || toolUses !== undefined || durationMs !== undefined)) usage = { totalTokens: tokens ?? 0, toolUses: toolUses ?? 0, durationMs: durationMs ?? 0 };
  if (usage && !usage.toolUses && toolUses) usage.toolUses = toolUses;
  const job = recordAgent(
    root,
    jobId,
    {
      role,
      phase: 'end',
      model: o.model ?? usage?.model ?? undefined,
      agentId,
      status: o.status,
      summary,
      // The transcript's path and cursor are set to undefined, so the usage job.json records is
      // only token counts; the cursor goes to the agent record instead.
      usage: usage ? ({ ...usage, transcript: undefined, through: undefined } as AgentUsage) : undefined,
      importedThrough: usage?.through,
      ...(outputMissing !== null ? { outputMissing } : {}),
      ...(metered || unmeasured ? { flags: { ...(metered ? { metered: true as const } : {}), ...(unmeasured ? { unmeasured: true as const } : {}) } } : {}),
    },
    config,
    fence,
  );
  // The driver's agents are its activity: an end keeps the lease for the usual span.
  renewLease(root, jobId, {});
  const a = job.agents[role];
  const budget = enforceBudget(root, config, job.id, 'agent-end');
  return { role, status: a.status, model: a.model, usage: usage ? { tokens: usage.totalTokens, exact: Boolean(usage.exact), ...(since && usage.transcript ? { since } : {}) } : null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd, ...(unmeasured ? { unmeasured: true } : {}), ...(outputMissing !== null ? { outputMissing } : {}), ...(secrets ? { secrets } : {}), ...(budget ? { budget } : {}) };
}
