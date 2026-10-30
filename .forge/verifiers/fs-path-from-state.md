---
paths: [lib/**/*.ts]
severity: major
mode: warn
---
Does every path this diff takes from job.json, config, a worktree or git output open without following a link (`O_NOFOLLOW`, plus `O_NONBLOCK` for reads), and does every recursive delete or write to such a path first check it stays under the root it expects?

- The builder can plant a symlink or a FIFO in its worktree or job dir, so a path read from there can point anywhere or block a read forever.
- Patterns to copy: `readRegular` in `lib/core/os/fs.ts`; `openConfinedLog` in `lib/engine/environment/status.ts`, as `lib/server/static.ts` uses it; `recordsSafe` before `fs.rmSync` in `lib/core/paths.ts`; `isInsidePath` in `lib/core/os/fs.ts` for config-relative paths; and, for a path that names a program, `isClaudeExecutable` in `lib/core/os/process.ts` with `insideRepo` in `lib/core/config/trust.ts`.
- Answer YES for paths Forge builds from fixed names under a root it already checked.
