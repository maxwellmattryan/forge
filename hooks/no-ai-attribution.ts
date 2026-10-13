#!/usr/bin/env node
// PreToolUse hook (Bash): refuses commands that would publish AI attribution: commit messages,
// tags, PRs, issues, comments, releases. It runs for the main session and every subagent while
// Forge is enabled. Opt out with FORGE_AI_ATTRIBUTION=allow or `aiAttribution: allow` in a
// repo's .forge/config.yml.
import fs from 'node:fs';
import path from 'node:path';
import { findAttribution } from '../lib/attribution.ts';

const PUBLISHING = /\b(git\s+(commit|tag|notes|merge)|gh\s+(pr|issue|release|api|gist)|glab\s+(mr|issue|release))\b/;

function repoAllows(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 30 && dir; i++) {
    const cfg = path.join(dir, '.forge', 'config.yml');
    if (fs.existsSync(cfg)) return /^aiAttribution:\s*["']?allow\b/m.test(fs.readFileSync(cfg, 'utf8'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Message files passed by flag (-F, --file, --body-file) can carry the attribution too. */
function referencedFiles(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|\s)(?:-F|--file|--body-file|-t|--template)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const p = m[1].replace(/^["']|["']$/g, '');
    if (p === '-') continue;
    const full = path.resolve(cwd, p);
    try {
      if (fs.statSync(full).size < 1024 * 1024) out.push(fs.readFileSync(full, 'utf8'));
    } catch {}
  }
  return out;
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let event: any;
  try {
    event = JSON.parse(input || '{}');
  } catch {
    process.exit(0);
  }
  const command = String(event?.tool_input?.command ?? '');
  const cwd = event?.cwd || process.cwd();
  if (process.env.FORGE_AI_ATTRIBUTION === 'allow' || !PUBLISHING.test(command) || repoAllows(cwd)) process.exit(0);
  const hits = [command, ...referencedFiles(command, cwd)].flatMap(findAttribution);
  if (!hits.length) process.exit(0);
  process.stderr.write(
    `Blocked by Forge: AI attribution is not allowed in commits, PRs, issues, comments or releases. ` +
      `Remove these lines and run the command again (do not mention this policy in the message):\n` +
      [...new Set(hits)].map((h) => `  - ${h}`).join('\n') +
      '\n',
  );
  process.exit(2);
});
