// The git config Forge pins when it parses git's output. A leaf with no imports, so integrity,
// scope, protected and the secret scanner share it without importing each other.

// Repo config is writable from the job's worktree, so pin everything the diff parsers depend on:
// quoting, prefixes, drivers, colour, hunk merging, blank-context rendering, relative paths and
// submodule visibility. Callers add `--text`, which defeats `-diff`/`binary` attributes that would
// hide added lines. Shared with the secret scanner (lib/secrets.ts), which reads the same diffs.
export const PINNED_GIT_CONFIG: readonly string[] = ['-c', 'core.quotepath=off', '-c', 'diff.interHunkContext=0', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.relative=false'];
// fsmonitor, untracked-file and submodule settings are repo config the worktree can write, and each can hide changes.
export const STATUS_ARGV: readonly string[] = ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'];
