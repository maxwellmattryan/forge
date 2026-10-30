// The machine cap's slot gate: one per machine dashboard, shared by every project's pool. Each pool
// still caps its own job sessions at daemon.maxConcurrent; this caps them across projects, so the
// account's usage limits hold however many projects run. A free slot goes to the waiting job with
// the oldest pending request on the machine (request ids start with Date.now(), so they compare
// across projects). Also the one place a pool session's child is started and handed work, what a spawn of a
// scope gets (effort, model, Forge's browser), and what kind of session a scope is: only job sessions count
// against `daemon.maxConcurrent` and the machine cap; the inbox, the office and the chats never do, and
// neither do the gate runs (lib/office/foreman/run.ts), which are no sessions. docs/architecture/daemon.md
// describes it.
import path from 'node:path';
import { INBOX_SCOPE, OFFICE_SCOPE, isChatScope, sharedScope } from '#core/job/requests.ts';
import { resolveEffort, validEffort, validModel } from '#core/config/load.ts';
import { loadJob } from '#core/job/store.ts';
import { jobDir } from '#core/paths.ts';
import { AGENT_TEXT_MAX, readRegularText } from '#core/os/fs.ts';
import { configForJob } from '#engine/evals/overlay.ts';
import { specUiAcs } from '#engine/pipeline/acs.ts';
import { browserMcpConfig } from '#integrations/claude/browser.ts';
import type { Session } from './session/contract.ts';
import type { Config, Effort, EffortSource, Job } from '#core/types.ts';

export type SessionKind = 'inbox' | 'office' | 'chat' | 'job';

export function sessionKind(scope: string): SessionKind {
  if (scope === INBOX_SCOPE) return 'inbox';
  if (scope === OFFICE_SCOPE) return 'office';
  return isChatScope(scope) ? 'chat' : 'job';
}

/** Counted against daemon.maxConcurrent and the machine cap: job sessions only. */
export const counted = (scope: string): boolean => sessionKind(scope) === 'job';

/** The office session's --model at its spawn: foreman.model when it is a valid model and not inherit, else null (daemon.command's). */
export function officeModel(c: Config): string | null {
  const m = validModel(c.foreman?.model);
  return m && m !== 'inherit' ? m : null;
}

/** The office session's --effort at its spawn: foreman.effort when it is valid, else the default effort (resolveEffort with no job). */
export function officeEffort(c: Config): { level: Effort | null; source: EffortSource } {
  const own = validEffort(c.foreman?.effort);
  return own ? { level: own, source: 'role' } : resolveEffort(c, null);
}

/**
 * The --effort a spawn of `scope` gets: the office session's officeEffort. Any other session runs the
 * orchestrator, with no role, so per-role, panel and complexity levels never reach its argv: only its
 * job's effort and runtime.effort do, under an eval job's overlaid config (a tampered overlay falls back
 * to the base, since step and verify refuse that job anyway). A missing or unreadable job falls back to the config's.
 */
export function sessionEffort(root: string, scope: string, c: Config): { level: Effort | null; source: EffortSource } {
  if (scope === OFFICE_SCOPE) return officeEffort(c);
  let job: Job | null = null;
  let jc = c;
  try {
    if (!sharedScope(scope)) job = loadJob(root, scope);
    if (job) jc = configForJob(root, c, job);
  } catch {}
  return resolveEffort(jc, job);
}

/** The --model a spawn of `scope` gets: the office session's officeModel; every other session keeps daemon.command's. */
export const sessionModel = (scope: string, c: Config): string | null => (scope === OFFICE_SCOPE ? officeModel(c) : null);

/**
 * The --mcp-config a spawn of `scope` gets: Forge's browser (browserMcpConfig) for a job session whose spec.md
 * has a UI AC and whose job has a port, read at every spawn; null for the inbox, the office, a chat, a job
 * with no spec, no UI AC, no port or an unreadable file, and a machine with no `npx` on `env`'s absolute PATH
 * entries. Only a boolean and the CLI-written port come from job files, and spec.md is read as a regular
 * file only, so a planted link or FIFO can't steer or stall the spawn.
 */
export function sessionBrowser(root: string, scope: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (sharedScope(scope)) return null;
  try {
    const job = loadJob(root, scope);
    const spec = readRegularText(path.join(jobDir(root, scope), 'spec.md'), AGENT_TEXT_MAX);
    if (spec === null || !specUiAcs(spec).length || typeof job.port !== 'number') return null;
    return browserMcpConfig({ root, port: job.port, outputDir: path.join(jobDir(root, scope), 'screenshots'), env });
  } catch {
    return null;
  }
}

/** Spawns `s` when no child runs, then hands it `eligible` as a turn (none for null: a chat, whose owner's message is its turn). False when the spawn was refused. */
export function startWork(s: Session, c: Config, reason: string, eligible: string[] | null): boolean {
  if (!s.running && !s.spawn(c, reason)) return false;
  if (eligible !== null) s.writeTurn(eligible);
  return true;
}

/** An idle, unkept job session a member could stop to free its slot. */
export interface IdleSession {
  lastResultAt: string | null;
  stop(): void;
}

/** One project's pool as the gate sees it. */
export interface SlotMember {
  /** Running job sessions. */
  live(): number;
  maxConcurrent(): number;
  /**
   * The oldest pending request id among its waiting job sessions, only while the pool is wanted and
   * below its own maxConcurrent: a waiter the machine cap holds. Null otherwise.
   */
  oldestWaiting(): string | null;
  /** Its idle job sessions with no agents keeping them. */
  idle(): IdleSession[];
  /** Job sessions already stopping, whose slots are about to be free. */
  stopping(): number;
  poke(): void;
}

export interface MachineSlots {
  /** The machine cap: the settings value, else the highest member maxConcurrent, else 1. */
  cap(): number;
  /** Running job sessions across every member. */
  live(): number;
  /** Adds a member; the function returned removes it. */
  join(member: SlotMember): () => void;
  /** Whether `member` may spawn the job whose oldest pending request is `oldest`: a slot is free and no other member's held waiter is older. */
  mayTake(member: SlotMember, oldest: string): boolean;
  /** Stops up to `n` idle, unkept job sessions in other members, oldest result first, less the slots already free or being freed. */
  reclaim(member: SlotMember, n: number): number;
  /** A member's job session exited: every other member gets a tick, so a held waiter can take the slot. */
  freed(member: SlotMember): void;
}

const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // One member's failing tick never stops another's.
  }
};

/** The gate; `setting()` is the machine index's settings.maxConcurrent (null: unset), read at every call. */
export function createMachineSlots(setting: () => number | null): MachineSlots {
  const members = new Set<SlotMember>();
  const others = (m: SlotMember) => [...members].filter((x) => x !== m);
  const cap = (): number => {
    const s = setting();
    if (Number.isInteger(s) && (s as number) >= 1) return s as number;
    return Math.max(1, ...[...members].map((m) => m.maxConcurrent()));
  };
  const live = (): number => [...members].reduce((n, m) => n + m.live(), 0);
  return {
    cap,
    live,
    join(member) {
      members.add(member);
      return () => void members.delete(member);
    },
    mayTake(member, oldest) {
      if (live() >= cap()) return false;
      const older = others(member).filter((m) => {
        const o = m.oldestWaiting();
        return o !== null && o < oldest;
      });
      if (!older.length) return true;
      // The older waiter's pool may not tick for a poll interval: give it the slot now.
      setImmediate(() => older.forEach((m) => safe(() => m.poke())));
      return false;
    },
    reclaim(member, n) {
      const pending = Math.max(0, cap() - live()) + others(member).reduce((k, m) => k + m.stopping(), 0);
      const want = n - pending;
      if (want <= 0) return 0;
      const idle = others(member)
        .flatMap((m) => m.idle())
        .sort((a, b) => (a.lastResultAt ?? '').localeCompare(b.lastResultAt ?? ''))
        .slice(0, want);
      for (const s of idle) safe(() => s.stop());
      return idle.length;
    },
    freed(member) {
      for (const m of others(member)) safe(() => m.poke());
    },
  };
}
