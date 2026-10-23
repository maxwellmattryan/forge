// The real ClaudeAdapter: spawns claude as the leader of its own process group, feeds its stdout and
// stderr through the protocol (stream.ts), and signals the whole group to stop it.
import { spawn as nodeSpawn } from 'node:child_process';
import { createStream } from './stream.ts';
import type { ClaudeAdapter, ClaudeChild } from './types.ts';

/** Signals a detached child's process group, so the signal reaches whatever it started. */
function defaultKillTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {}
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export function claudeAdapter(deps: { spawn?: typeof nodeSpawn; killTree?: (pid: number, signal: NodeJS.Signals) => void } = {}): ClaudeAdapter {
  const spawn = deps.spawn ?? nodeSpawn;
  const killTree = deps.killTree ?? defaultKillTree;
  return {
    start(argv, opts, onEvent) {
      const proc = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stream = createStream((line) => void proc.stdin?.write(line), onEvent, opts.maxLineBytes);
      let done!: () => void;
      const closed = new Promise<void>((resolve) => (done = resolve));
      proc.on('error', (e: Error) => onEvent({ kind: 'process-error', message: e.message, started: Boolean(proc.pid) }));
      // EPIPE on a child that died mid-write must not take the server down.
      proc.stdin?.on('error', (e: Error) => onEvent({ kind: 'stdin-error', message: e.message }));
      proc.stdout?.on('data', stream.stdout);
      proc.stderr?.on('data', stream.stderr);
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        onEvent({ kind: 'exit', code, signal });
        done();
      });
      const child: ClaudeChild = {
        get pid() {
          return proc.pid ?? null;
        },
        get paused() {
          return proc.stdout?.isPaused() ?? false;
        },
        closed,
        writeTurn: stream.writeTurn,
        answerPermission: stream.answerPermission,
        setPermissionMode: stream.setPermissionMode,
        endInput() {
          try {
            proc.stdin?.end();
          } catch {}
        },
        signal(sig) {
          // A child without a pid never started: there is nothing to signal.
          if (proc.pid) killTree(proc.pid, sig);
        },
        pause() {
          proc.stdout?.pause();
        },
        resume() {
          proc.stdout?.resume();
        },
      };
      return child;
    },
  };
}
