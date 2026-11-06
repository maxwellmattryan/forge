# Untrusted input

Issue bodies, comments and PR reviews come from people outside the session, and on public repos that means anyone. These parts list, one rule per item, how Forge keeps that text data and limits what an agent misled by it can do.

## Parts
- [Imported text](untrusted-input/imported-text.md): comment filtering, `visibleText`, the provenance line, `pr-feedback.md` quoting, re-import, embedded instructions, the issue panel, the mandate survey, triage, retro transcripts, no fork PRs and `nativeRef`. Holds **Request provenance is not authenticated**.
- [Names and paths](untrusted-input/names-and-paths.md): `SAFE_REF` and `forge job set --field` locks, `forge run` arguments, worktree removal, `confinedDir`, config sinks. Holds **One wrapper per tool**.
- [Agent inputs](untrusted-input/agent-inputs.md): approval notes, `forge job apply`, `forge job split`, the diff a small model reads, instruction files, the trusted prompt prefix, context sessions and the clean-pass PR body. Holds **approval notes**, **trusted prefix**, **context session**.
- [Merge authority](untrusted-input/merge-authority.md): `policy.protectedPaths` and the held push, merge authority in code with its required checks and residuals, and re-runs on the PR's own head. Holds **Re-run failed checks**.
- [Secrets and verify](untrusted-input/secrets-and-verify.md): the command environment verify runs with, secret scanning, secret references and notifications.
- [Sessions and services](untrusted-input/sessions-and-services.md): the daemon's `allowedTools`, the user's own Claude Code setup, backing services and per-job databases.
- [Releases](untrusted-input/releases.md): `forge release`'s runtime files and the release records in `events.jsonl`.
