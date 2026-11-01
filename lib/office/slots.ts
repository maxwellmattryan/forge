// The opt-in machine cap's slot gate: one per machine dashboard, shared by every project's pool. Each pool caps,
// orders and evicts its own job sessions at daemon.maxConcurrent; the gate holds them only when the machine
// index sets a cap (an opt-in bound on the account's usage across projects), as one shared count. It never
// orders waiters across projects and never stops a session: another project's pool can't hold back or
// stop this one's. Also the one place a pool session's child is started and handed work, what a spawn of a
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

/** The `_office` scope's --model (the retired office session's): foreman.model when it is a valid model and not inherit, else null (daemon.command's). */
export function officeModel(c: Config): string | null {
  const m = validModel(c.foreman?.model);
  return m && m !== 'inherit' ? m : null;
}

/** The `_office` scope's --effort (the retired office session's): foreman.effort when it is valid, else the default effort (resolveEffort with no job). */
export function officeEffort(c: Config): { level: Effort | null; source: EffortSource } {
  const own = validEffort(c.foreman?.effort);
  return own ? { level: own, source: 'role' } : resolveEffort(c, null);
}

/**
 * The --effort a spawn of `scope` gets: officeEffort for `_office` (the retired office session's scope). Any other session runs the
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

/** The --model a spawn of `scope` gets: officeModel for `_office` (the retired office session's scope); every other session keeps daemon.command's. */
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

/** One project's pool as the gate sees it. */
export interface SlotMember {
  /** Running job sessions. */
  live(): number;
  /** While the pool is wanted and open: its last tick held a waiter below its own maxConcurrent because of the machine cap. */
  held(): boolean;
  poke(): void;
}

export interface MachineSlots {
  /** The explicit machine cap: the settings value when it is an integer ≥ 1, else null (no machine cap). */
  cap(): number | null;
  /** Running job sessions across every member. */
  live(): number;
  /** Adds a member; the function returned removes it. */
  join(member: SlotMember): () => void;
  /** Whether `member` may spawn a job session: always without a machine cap, else while fewer than the cap run across members. */
  mayTake(member: SlotMember): boolean;
  /** A member's job session exited: with a machine cap, each other member the cap holds gets a tick, so its waiter can take the slot. */
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
  const cap = (): number | null => {
    const s = setting();
    return Number.isInteger(s) && (s as number) >= 1 ? (s as number) : null;
  };
  const live = (): number => [...members].reduce((n, m) => n + m.live(), 0);
  return {
    cap,
    live,
    join(member) {
      members.add(member);
      return () => void members.delete(member);
    },
    mayTake() {
      const c = cap();
      return c === null || live() < c;
    },
    freed(member) {
      if (cap() === null) return;
      const held = others(member).filter((m) => m.held());
      // A held pool may not tick for a poll interval: give it the slot now.
      if (held.length) setImmediate(() => held.forEach((m) => safe(() => m.poke())));
    },
  };
}
