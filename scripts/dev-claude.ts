// `npm run dev:claude [-- <claude args>]`: Claude Code on this checkout's plugin, from the directory
// npm was run in. --plugin-dir replaces an installed `forge` plugin for the session, and bin/ goes
// first on PATH so every `forge` the session runs is this checkout's.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT } from '../lib/core/paths.ts';

/** The claude call for `argv`: the checkout as the plugin dir, its bin/ first on PATH. */
export function claudePlan(argv: string[], env: NodeJS.ProcessEnv = process.env): { command: 'claude'; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  // The same shape as sessionEnv() in lib/daemon.ts.
  const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  return { command: 'claude', args: ['--plugin-dir', PLUGIN_ROOT, ...argv], cwd: path.resolve(env.INIT_CWD || process.cwd()), env: { ...env, PATH } };
}

function main(): void {
  const plan = claudePlan(process.argv.slice(2));
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' });
  // claude owns the terminal and handles Ctrl-C itself; this wrapper must outlive that keypress.
  process.on('SIGINT', () => {});
  for (const s of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(s, () => {
      try {
        child.kill(s);
      } catch {}
    });
  }
  child.on('error', (e: NodeJS.ErrnoException) => {
    process.stderr.write(e.code === 'ENOENT' ? 'claude is not on PATH: install Claude Code first\n' : `claude: ${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
