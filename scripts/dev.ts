// `npm run dev [-- --port N]`: a watching Vite build of the dashboard into the gitignored dev build
// dir, served by this checkout's `forge dash --dev` for the repo npm was run from. One Ctrl-C stops
// both. The committed build is never written: only `npm run build:dashboard` produces that.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEV_DIST_DIR, PLUGIN_ROOT } from '../lib/paths.ts';

/** One child the supervisor runs. */
export interface DevProc {
  name: string;
  command: string;
  args: string[];
  cwd: string;
}

const USAGE = 'usage: npm run dev [-- --port N]';
// Run through node and its bin path, never npx or an import: no PATH lookup, no runtime dependency.
const VITE_BIN = path.join(PLUGIN_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** The two children for `argv`; throws the usage line on anything but `--port <0-65535>`. */
export function devPlan(argv: string[], env: NodeJS.ProcessEnv = process.env): { vite: DevProc; dash: DevProc } {
  const port: string[] = [];
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--port' || !/^\d{1,5}$/.test(argv[1]) || Number(argv[1]) > 65535) throw new Error(USAGE);
    port.push('--port', String(Number(argv[1])));
  }
  const vite: DevProc = {
    name: 'vite',
    command: process.execPath,
    args: [VITE_BIN, 'build', '--watch', '--config', path.join(PLUGIN_ROOT, 'dashboard', 'vite.config.mjs'), '--outDir', DEV_DIST_DIR, '--emptyOutDir'],
    cwd: PLUGIN_ROOT,
  };
  // INIT_CWD is where `npm run` was typed, so `npm --prefix <checkout> run dev` serves that repo.
  const dash: DevProc = {
    name: 'forge dash',
    command: process.execPath,
    args: [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'dash', '--dev', ...port],
    cwd: path.resolve(env.INIT_CWD || process.cwd()),
  };
  return { vite, dash };
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
// A Ctrl-C reaches the children and this process together; a child's exit seen first must not
// read as "it stopped by itself", so a self-exit is acted on only after this much quiet.
const SELF_EXIT_SETTLE_MS = 100;

/**
 * Runs `procs` until all have exited and resolves with the script's exit code. A first SIGINT,
 * SIGTERM or SIGHUP sends SIGTERM to every live child and resolves 0 once all are gone; a second
 * one, or `killAfterMs` after the SIGTERM, sends SIGKILL. A child that exits by itself stops the
 * others and resolves with its code (1 when that is 0 or missing). A spawn error counts as exit 1.
 */
export function supervise(procs: DevProc[], opts: { killAfterMs?: number; log?: (s: string) => void } = {}): Promise<number> {
  const killAfterMs = opts.killAfterMs ?? 15_000;
  const log = opts.log ?? ((s: string) => process.stderr.write(`[dev] ${s}\n`));
  return new Promise((resolve) => {
    const live = new Map<string, ChildProcess>();
    const timers = new Set<NodeJS.Timeout>();
    let result: number | null = null;
    let stopping = false;
    let settling = false;
    let done = false;

    const finish = () => {
      if (done || live.size || settling) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      for (const s of STOP_SIGNALS) process.removeListener(s, onSignal);
      resolve(result ?? 0);
    };
    const kill = (signal: NodeJS.Signals) => {
      for (const c of live.values()) {
        try {
          c.kill(signal);
        } catch {}
      }
    };
    const stopAll = (code: number) => {
      if (stopping) return;
      stopping = true;
      result = code;
      kill('SIGTERM');
      timers.add(
        setTimeout(() => {
          if (live.size) log(`${[...live.keys()].join(' and ')} still running ${killAfterMs} ms after SIGTERM; killing`);
          kill('SIGKILL');
        }, killAfterMs),
      );
    };
    function onSignal(signal: NodeJS.Signals) {
      if (stopping) {
        log(`${signal} again: killing ${[...live.keys()].join(' and ') || 'nothing'}`);
        return kill('SIGKILL');
      }
      log(`${signal}: stopping ${[...live.keys()].join(' and ')}`);
      stopAll(0);
    }
    const exited = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
      if (!live.delete(name)) return;
      if (!stopping && !settling) {
        const own = code ? code : 1;
        log(`${name} exited (${signal ?? `code ${code}`}); stopping the rest`);
        settling = true;
        timers.add(
          setTimeout(() => {
            settling = false;
            stopAll(own);
            finish();
          }, SELF_EXIT_SETTLE_MS),
        );
      }
      finish();
    };

    for (const s of STOP_SIGNALS) process.on(s, onSignal);
    for (const p of procs) {
      // Not detached: a terminal Ctrl-C reaches the children directly too, so `forge dash` runs its
      // own SIGINT shutdown and stops its sessions.
      const child = spawn(p.command, p.args, { cwd: p.cwd, stdio: 'inherit' });
      live.set(p.name, child);
      child.on('exit', (code, signal) => exited(p.name, code, signal));
      child.on('error', (e) => {
        // A failed spawn emits no exit; an error from kill() on a live child is not an exit.
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) return;
        log(`${p.name}: ${e.message}`);
        exited(p.name, 1, null);
      });
    }
  });
}

async function main(): Promise<void> {
  let plan: ReturnType<typeof devPlan>;
  try {
    plan = devPlan(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(VITE_BIN)) {
    process.stderr.write('vite is not installed in this checkout: run npm ci\n');
    process.exit(1);
  }
  fs.rmSync(DEV_DIST_DIR, { recursive: true, force: true });
  process.stderr.write(`[dev] building the dashboard into ${DEV_DIST_DIR}; the page answers 503 until the first build lands (about 10 s)\n`);
  process.exit(await supervise([plan.vite, plan.dash]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
