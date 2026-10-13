// @ts-check
// `forge dash`: start the dashboard in the foreground or as a detached, pid-tracked process.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, PLUGIN_ROOT } from '../paths.mjs';
import { reapOrphan } from '../daemon.mjs';
import { ForgeError, readJson, sleepSync, writeJsonAtomic } from '../util.mjs';
import { pidAlive } from '../worktree.mjs';
import { out } from './args.mjs';

/** @param {string} root @param {any} config @param {Record<string, any>} flags */
export async function dash(root, config, flags) {
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
      // The server stops its daemon on SIGTERM (up to its grace period) before exiting.
      for (let i = 0; i < 160 && pidAlive(current.pid); i++) sleepSync(50);
    }
    writeJsonAtomic(rtFile, {});
    // Whatever the server could not stop (it was SIGKILLed, or hung) is reaped here.
    const { reaped } = reapOrphan(root);
    return out({ stopped: Boolean(alive), daemonReaped: reaped }, flags);
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
  const { startServer } = await import('../server.mjs');
  let res;
  for (let p = port; p < port + 20; p++) {
    try {
      res = await startServer(root, { port: p });
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EADDRINUSE') throw e;
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
  // Last resort (an uncaught exception, a plain exit): signal the daemon's group synchronously.
  process.on('exit', () => server.daemon.killSync());
  process.stdout.write(`⚒️  Forge dashboard → ${res.url}\n`);
}
