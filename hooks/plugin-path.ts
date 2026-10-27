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
    const pathLine = `export PATH=${q(bin)}:"$PATH"`;
    const modeLine = 'export FORGE_MODE=agent';
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // Resume, clear and compact run the hook again on the same file, and a long-lived session may have
    // been resumed under other installs too, each prepending its own bin/. The last PATH line sourced
    // wins, so ours must be the last one, not merely present: move it to the end when it isn't.
    const have = current.split('\n');
    if (have.at(-1) === '') have.pop();
    const ours = have.filter((l) => l.startsWith('export PATH=')).at(-1) === pathLine;
    const mode = have.includes(modeLine);
    if (!ours || !mode) {
      const next = ours ? have : [...have.filter((l) => l !== pathLine), pathLine];
      if (!mode) next.push(modeLine);
      // Claude Code sources this file before every Bash command: write aside and rename, so none reads half of it.
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, next.map((l) => l + '\n').join(''));
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  }
} catch (e) {
  process.stderr.write(`forge plugin-path hook: ${(e as Error).message}\n`);
}
process.exitCode = 0;
