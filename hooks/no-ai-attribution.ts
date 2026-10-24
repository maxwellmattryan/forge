#!/usr/bin/env node
// PreToolUse hook (Bash): refuses commands that would publish AI attribution: commit messages,
// tags, PRs, issues, comments, releases. It runs for the main session and every subagent while
// Forge is enabled, and checks every git, gh or glab command and the message files it names
// (lib/engine/guard/attribution.ts commandAttribution). Opt out with FORGE_AI_ATTRIBUTION=allow, or
// `aiAttribution: allow` in the .forge/config.yml of the main checkout of CLAUDE_PROJECT_DIR (the
// project Claude Code runs in), never a worktree's own config or the command's cwd.
import { commandAttribution, repoAllowsAttribution } from '../lib/engine/guard/attribution.ts';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let event: any;
  try {
    event = JSON.parse(input || '{}');
  } catch {
    process.exit(0);
  }
  if (process.env.FORGE_AI_ATTRIBUTION === 'allow') process.exit(0);
  const command = String(event?.tool_input?.command ?? '');
  const cwd = typeof event?.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  // Only a command that carries attribution pays for the git child the opt-out lookup starts.
  const hits = commandAttribution(command, cwd);
  if (!hits.length || repoAllowsAttribution(process.env.CLAUDE_PROJECT_DIR)) process.exit(0);
  process.stderr.write(
    `Blocked by Forge: AI attribution is not allowed in commits, PRs, issues, comments or releases. ` +
      `Remove these lines and run the command again (do not mention this policy in the message):\n` +
      hits.map((h) => `  - ${h}`).join('\n') +
      '\n',
  );
  process.exit(2);
});
