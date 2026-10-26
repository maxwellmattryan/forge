// Token usage read from Claude Code transcripts: deduped by message id, tools counted by block id,
// output estimated from content because the logged count is the stream's opening snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { agentTranscriptById, claudeProjectsDir, openTranscript } from '#integrations/claude/transcripts.ts';
import type { TranscriptHit } from '#integrations/claude/transcripts.ts';
import { CHARS_PER_TOKEN, composeContext } from './composition.ts';
import type { AgentUsage, ContextComposition, Job } from '#core/types.ts';

/**
 * What importClaudeCodeTranscript returns: AgentUsage's transcript fields, all set, plus the file
 * read, `through`, the transcript's last timestamp (the cursor the next import of this agent
 * passes as `since`), and the span's context composition.
 */
export type TranscriptUsage = Required<Pick<AgentUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'toolUses' | 'durationMs' | 'totalTokens' | 'exact' | 'outputEstimated'>> & {
  model: string | null;
  transcript: string;
  through: string | null;
  composition: ContextComposition | null;
};

/**
 * Claude Code keeps every subagent's transcript on disk; summing its per-message usage gives an
 * exact input/output/cache breakdown that the completion notification does not carry.
 * Each content block is logged as its own line sharing the message id, and the logged usage is the
 * message_start snapshot: input and cache counts are exact, output_tokens is not. Output is therefore
 * estimated from the logged content (≈3.5 chars/token) whenever that exceeds the logged value.
 * A resumed agent (SendMessage) appends to the same file, so `since` (the previous import's
 * `through`) skips every line at or before it: each import counts, and times, only the new span.
 * A line without a timestamp belongs to the span of the timestamped line before it.
 * Given the job and root, the transcript is looked up under the job's sessions in this repo's project
 * dirs first (lib/integrations/claude/transcripts.ts); the scan of every project dir stays as the fallback for an agent
 * whose parent session isn't recorded. `promptChars` is the role prompt's length, the Forge share
 * of the composition's start prefix beside the brief (composeContext in ./composition.ts).
 */
export function importClaudeCodeTranscript(
  agentId: string,
  opts: { projectsDir?: string; since?: string | null; root?: string; job?: Pick<Job, 'id' | 'lease' | 'runs' | 'agents' | 'worktree'>; promptChars?: number } = {},
): TranscriptUsage | null {
  const projects = opts.projectsDir ?? claudeProjectsDir();
  const hit = opts.root && opts.job ? agentTranscriptById(opts.root, opts.job, agentId, { projects }) : null;
  const file = (hit ? readConfined(hit, projects) : null) ?? readScanned(findTranscript(projects, `agent-${agentId}.jsonl`));
  if (!file) return null;
  return summarise(file.text, file.path, opts.since, opts.promptChars ?? 0);
}

/** A located transcript's path and text, read through openTranscript's confined descriptor. */
function readConfined(hit: TranscriptHit, projects: string): { path: string; text: string } | null {
  const t = openTranscript(hit, projects);
  if (!t) return null;
  try {
    return { path: hit.path, text: fs.readFileSync(t.fd, 'utf8') };
  } finally {
    fs.closeSync(t.fd);
  }
}

/** The fallback scan's hit, read as before. */
function readScanned(file: string | null): { path: string; text: string } | null {
  return file ? { path: file, text: fs.readFileSync(file, 'utf8') } : null;
}

/** A transcript's lines parsed once, in file order; blank and unparseable lines are left out. */
function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function summarise(text: string, file: string, sinceAt: string | null | undefined, promptChars: number): TranscriptUsage {
  // usage is a transcript line's raw usage object.
  const byMessage = new Map<string, { usage: any; model: string | null; chars: number }>();
  const toolIds = new Set<string>();
  const since = sinceAt ? Date.parse(sinceAt) : NaN;
  let skipping = !Number.isNaN(since);
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let through: string | null = sinceAt ?? null;
  const lines = parseLines(text);
  for (const line of lines) {
    const o = line as any;
    if (o === null || typeof o !== 'object') continue;
    if (o.timestamp) {
      through = o.timestamp;
      if (skipping) skipping = !(Date.parse(o.timestamp) > since);
      if (!skipping) {
        firstTs ??= o.timestamp;
        lastTs = o.timestamp;
      }
    }
    if (skipping) continue;
    const msg = o.message;
    if (o.type !== 'assistant' || !msg?.usage) continue;
    const key = msg.id ?? o.uuid;
    const entry = byMessage.get(key) ?? { usage: msg.usage, model: msg.model ?? null, chars: 0 };
    if ((msg.usage.output_tokens ?? 0) > (entry.usage.output_tokens ?? 0)) entry.usage = msg.usage;
    for (const c of msg.content ?? []) {
      if (c?.type === 'tool_use') {
        if (c.id) toolIds.add(c.id);
        entry.chars += JSON.stringify(c.input ?? {}).length + String(c.name ?? '').length;
      } else if (c?.type === 'text') entry.chars += String(c.text ?? '').length;
      else if (c?.type === 'thinking') entry.chars += String(c.thinking ?? '').length;
    }
    byMessage.set(key, entry);
  }
  const composition = composeContext(lines, { since: sinceAt, promptChars });
  const out: TranscriptUsage = { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: toolIds.size, durationMs: 0, totalTokens: 0, exact: true, outputEstimated: false, transcript: file, through, composition };
  for (const m of byMessage.values()) {
    const u = m.usage;
    out.model ??= m.model;
    out.input += u.input_tokens ?? 0;
    out.cacheRead += u.cache_read_input_tokens ?? 0;
    out.cacheWrite += u.cache_creation_input_tokens ?? 0;
    const estimated = Math.ceil(m.chars / CHARS_PER_TOKEN);
    if (estimated > (u.output_tokens ?? 0)) out.outputEstimated = true;
    out.output += Math.max(u.output_tokens ?? 0, estimated);
  }
  out.totalTokens = out.input + out.output + out.cacheRead + out.cacheWrite;
  if (firstTs && lastTs) out.durationMs = Date.parse(lastTs) - Date.parse(firstTs);
  return out;
}

function findTranscript(projects: string, name: string): string | null {
  if (!fs.existsSync(projects)) return null;
  for (const proj of fs.readdirSync(projects)) {
    const projDir = path.join(projects, proj);
    let sessions;
    try {
      sessions = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const candidate = path.join(projDir, s.name, 'subagents', name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
