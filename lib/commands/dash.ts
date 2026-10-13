// `forge dash`: start the dashboard in the foreground or as a detached, pid-tracked process.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, PLUGIN_ROOT } from '../paths.ts';
import { reapOrphans } from '../daemon.ts';
import { ForgeError, readJson, sleepSync, writeJsonAtomic } from '../util.ts';
import { pidAlive } from '../worktree.ts';
import { out } from './args.ts';
import type { RunningServer } from '../server.ts';
import type { Config } from '../types.ts';

export async function dash(root: string, config: Config, flags: Record<string, any>): Promise<void> {
  const rtFile = path.join(paths(root).runtime, 'dashboard.json');
  const current = readJson(rtFile, null);
  const alive = current?.pid && (() => {
    try {
      process.kill(current.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (flags.stop) {
    if (alive) {
      process.kill(current.pid, 'SIGTERM');
      // The server stops its sessions on SIGTERM before exiting: up to 5 s of grace, then SIGKILL
      // and up to 5 s more. 12 s covers that with room to close the server.
      for (let i = 0; i < 240 && pidAlive(current.pid); i++) sleepSync(50);
    }
    writeJsonAtomic(rtFile, {});
    // Whatever the server could not stop (it was SIGKILLed, or hung) is reaped here.
    const { reaped } = reapOrphans(root);
    return out({ stopped: Boolean(alive), daemonReaped: reaped.length > 0 }, flags);
  }
  if (alive && !flags.foreground) return out({ url: current.url, pid: current.pid, running: true }, flags);
  const port = Number(flags.port ?? config.dashboard.port ?? 7400);
  if (flags.background) {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), 'dash', '--foreground', '--port', String(port)], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      const rt = readJson(rtFile, null);
      if (rt?.pid === child.pid) return out({ url: rt.url, pid: child.pid, started: true }, flags);
      sleepSync(50);
    }
    return out({ url: `http://127.0.0.1:${port}`, pid: child.pid, started: true, unconfirmed: true }, flags);
  }
  const { startServer } = await import('../server.ts');
  let res: RunningServer | undefined;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer(root, { port: p });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!res) throw new ForgeError(`no free port near ${port}`);
  writeJsonAtomic(rtFile, { pid: process.pid, url: res.url, startedAt: new Date().toISOString() });
  const server = res;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Last resort (an uncaught exception, a plain exit): signal every session's group synchronously.
  process.on('exit', () => server.pool.killSync());
  process.stdout.write(`⚒️  Forge dashboard → ${res.url}\n`);
}
