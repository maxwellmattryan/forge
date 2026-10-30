// What the running machine dashboard does to stay up: the sleep assertion it holds while a project has
// work in flight, the boot pass that resumes a project's undriven jobs as its pool boots, and the
// restart record and notifications a service start writes once those passes settle.
import { loadConfig } from '#core/config/load.ts';
import { listJobs } from '#core/job/store.ts';
import { GATES_SCOPE, INBOX_SCOPE, OFFICE_SCOPE, listRequests, requestScope } from '#core/job/requests.ts';
import { readMachineIndex } from '#engine/project/machine-index.ts';
import { writeUptime } from '#engine/project/login-service.ts';
import { createSleepHold, sleepHoldCommand } from '#integrations/os-service/sleep.ts';
import { isReadable, mandateState } from '#office/mandates/contract.ts';
import { listMandates } from '#office/mandates/store.ts';
import { queueNotify, type QueueNotify } from '#office/notify.ts';
import { reconcile, type SessionFacts } from '#office/reconcile.ts';
import type { DaemonPool } from '#office/pool.ts';
import type { Entries, KeepAwakeOptions, ProjectBoot } from './types.ts';

/** The stages where an agent works on a running job: what a running job must be at to hold the machine awake. */
export const AGENT_STAGES: readonly string[] = ['plan', 'spec', 'design', 'build', 'verify', 'review', 'integrate', 'decide'];

/** How often the machine dashboard checks whether any project still needs the machine awake. */
export const KEEP_AWAKE_MS = 15_000;

/** `status: active` with the derived state active: not paused, closed or waiting on its `after`. */
function activeMandates(root: string): number {
  const all = listMandates(root);
  return all.filter((m) => isReadable(m) && m.status === 'active' && mandateState(m, all) === 'active').length;
}

/**
 * Whether one project holds the machine awake: its pool is wanted, daemon.keepAwake is auto, and it has
 * an active mandate or a running job at an agent stage. Never throws: an unreadable config holds nothing.
 */
export function holdsAwake(root: string, wanted: boolean): boolean {
  if (!wanted) return false;
  try {
    if (loadConfig(root).config.daemon?.keepAwake !== 'auto') return false;
    if (activeMandates(root) > 0) return true;
    return listJobs(root).some((j) => j.state === 'running' && AGENT_STAGES.includes(j.stage));
  } catch {
    return false;
  }
}

/**
 * The machine's sleep assertion over the loaded projects: checked now and every `intervalMs`
 * (KEEP_AWAKE_MS), held while any project holdsAwake, recorded in uptime.json's `keepAwake` whenever
 * held, projects or error change. A no-op with `env.FORGE_KEEP_AWAKE` `never` or on a platform with no
 * helper. close() releases it and records `held: false`.
 */
export function startKeepAwake(entries: Pick<Entries, 'list'>, home: string, opts: KeepAwakeOptions): { close(): void; killSync(): void } {
  const pid = opts.pid ?? process.pid;
  const command = sleepHoldCommand(opts.platform ?? process.platform, pid);
  if (opts.env?.FORGE_KEEP_AWAKE === 'never' || !command) return { close() {}, killSync() {} };
  const hold = createSleepHold({ command, spawn: opts.spawn });
  let last: string | null = null;
  const record = (projects: string[]): void => {
    const st = hold.state();
    const key = JSON.stringify([st.held, projects, st.error]);
    if (key === last) return;
    last = key;
    try {
      writeUptime(home, { keepAwake: { pid, held: st.held, since: st.since, projects, error: st.error, at: new Date().toISOString() } });
    } catch (e) {
      process.stderr.write(`keep awake: ${(e as Error).message}\n`);
    }
  };
  let closed = false;
  const check = (): void => {
    if (closed) return;
    const projects: string[] = [];
    try {
      for (const e of entries.list()) if (holdsAwake(e.root, e.pool.state().wanted)) projects.push(e.name);
    } catch {
      // A project unloading mid-check is skipped; the next check sees the rest.
    }
    hold.set(projects.length > 0);
    record(projects);
  };
  check();
  const timer = setInterval(check, opts.intervalMs ?? KEEP_AWAKE_MS);
  timer.unref();
  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      hold.release();
      record([]);
    },
    killSync() {
      closed = true;
      clearInterval(timer);
      hold.killSync();
    },
  };
}

/**
 * One project's boot pass, run as its pool boots: one reconciler pass with the pool's session facts, so
 * a running job left undriven gets its fixed resume request at once rather than after RECONCILE_MS.
 * The reconciler's memory and lock keep a later pass from queueing a second one. Returns what is in
 * flight after it: running jobs, open Office requests and active mandates. Never throws: a failure is
 * written to stderr and the project left out (null).
 */
export async function resumeProject(name: string, root: string, pool: Pick<DaemonPool, 'facts' | 'state' | 'poke'>): Promise<ProjectBoot | null> {
  try {
    const { config } = loadConfig(root);
    const state = pool.state();
    const scopes = [INBOX_SCOPE, OFFICE_SCOPE, ...Object.keys(state.jobs)];
    const facts = new Map<string, SessionFacts>();
    const busy: string[] = [];
    for (const j of listJobs(root)) {
      const f = j.state === 'running' ? pool.facts(j.id) : null;
      if (f) facts.set(j.id, f);
    }
    for (const s of scopes) {
      const f = pool.facts(s);
      if (f && (f.status === 'busy' || f.status === 'stopping')) busy.push(...f.ids);
    }
    const r = await reconcile(root, config, { facts, busy });
    // The resume reaches its session at once, not at the pool's next poll.
    if (r.resumed.length) pool.poke();
    const jobs = listJobs(root).filter((j) => j.state === 'running').length;
    // Open Office requests: the office runner's draft and direct requests and the gate runner's gate requests.
    const office = listRequests(root).filter((q) => {
      if (q.status !== 'pending' && q.status !== 'in-progress') return false;
      const scope = requestScope(root, q);
      return scope === OFFICE_SCOPE || scope === GATES_SCOPE;
    }).length;
    return { name, jobs, office, mandates: activeMandates(root) };
  } catch (e) {
    process.stderr.write(`boot pass (${name}): ${(e as Error).message}\n`);
    return null;
  }
}

/**
 * A service start's restart record, written once the boot passes settle: uptime.json's `restart`, then
 * one `service-restarted` notification through each project's own notify config for each project with
 * running jobs or open Office requests, and none for the rest. Never throws.
 */
export function recordRestart(home: string, boots: ProjectBoot[], queue: QueueNotify = queueNotify): void {
  try {
    writeUptime(home, { restart: { at: new Date().toISOString(), pid: process.pid, projects: boots.map((b) => ({ name: b.name, jobs: b.jobs, office: b.office, mandates: b.mandates })) } });
  } catch (e) {
    return void process.stderr.write(`restart record: ${(e as Error).message}\n`);
  }
  let roots: Map<string, string>;
  try {
    roots = new Map(readMachineIndex(home).projects.map((p) => [p.name, p.path]));
  } catch (e) {
    return void process.stderr.write(`restart notifications: ${(e as Error).message}\n`);
  }
  for (const b of boots) {
    const root = roots.get(b.name);
    if (root && b.jobs + b.office > 0) queue(root, ['service-restarted'], { job: null, reason: 'service-restarted' });
  }
}
