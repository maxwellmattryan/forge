# lib/integrations/

Code that knows an outside system's API, CLI or file format, one folder per system: mechanism only, never pipeline policy.

- Each system has one client (auth, timeouts, output parsing) that everything using it shares. A git, gh or docker process starts only in `git/runner.ts`, `github/gh.ts` or `docker/runner.ts`.
- Integrations import only `core` and `api`. When to retarget, rework or merge stays in `lib/engine/`.
- The security wrappers (secret scanning of outgoing text, fencing of incoming text) live in engine's loaders around every adapter, never inside one adapter here.
- Design: [Untrusted input](../../docs/architecture/untrusted-input.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `backlog/` | The built-in markdown backlog tracker, behind the same contract as the GitHub one. |
| `claude/` | Claude Code's command line, protocol, files and prices: the session argv and env, the stream-json protocol and the child that speaks it, transcripts and the model price table. |
| `docker/` | The one Docker runner: sync, async and streaming. |
| `git/` | The one git runner, with its config pins and clean environment, and the offline repo slug. |
| `github/` | GitHub through `gh`: the runner, pull requests, the GitHub tracker, issue previews and the actor. |
<!-- forge:map:end -->
