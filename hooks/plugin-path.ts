#!/usr/bin/env node
// SessionStart hook: puts this plugin's bin/ first on PATH for every Bash command of the session,
// subagents included. Claude Code appends a plugin's bin/ to the end of PATH, so a `forge` earlier
// on PATH (a ~/.local/bin shim, an `npm link`) would otherwise run another install's CLI against
// this plugin's skills. Claude Code sources $CLAUDE_ENV_FILE before each Bash command.
// It also pins FORGE_MODE=agent: a Bash call can run under a PTY, and the orchestrator, job sessions
// and subagents read forge's output as JSON, never as human-mode text.
//
// Self-contained (built-ins only, no relative imports), and the line depends only on where this
// file sits: no stdin, no cwd, no CLAUDE_PLUGIN_ROOT. Nothing goes to stdout, which SessionStart
// turns into model context, and it always exits 0: a hook must never break session start.
import fs from 'node:fs';
import path from 'node:path';

/** POSIX single quotes: nothing inside is expanded when the env file is sourced. */
const q = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";

try {
  const file = process.env.CLAUDE_ENV_FILE;
  if (file && process.platform !== 'win32') {
    const bin = path.resolve(import.meta.dirname, '..', 'bin');
    const lines = [`export PATH=${q(bin)}:"$PATH"`, 'export FORGE_MODE=agent'];
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // Resume, clear and compact run the hook again on the same file.
    const have = current.split('\n');
    const missing = lines.filter((l) => !have.includes(l));
    if (missing.length) fs.appendFileSync(file, (current && !current.endsWith('\n') ? '\n' : '') + missing.map((l) => l + '\n').join(''));
  }
} catch (e) {
  process.stderr.write(`forge plugin-path hook: ${(e as Error).message}\n`);
}
process.exitCode = 0;
