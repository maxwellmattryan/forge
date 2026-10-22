# lib/core/

Foundations with no pipeline policy: shared shapes, the job store and schema, config, paths, errors, and OS and text helpers.

- `types.ts` holds the shared shapes, type-only: import them with `import type`. It re-exports the `/api` shapes from `lib/api/types.ts`.
- `errors.ts` imports nothing local and `utils.ts` nothing at all, so every module can use them. `os/` and `format/` stay leaves too: Node built-ins and OS process tools live here, never the repo's own configured commands (those are `engine/`).
- When a module here needs something from a higher layer, move the shared piece down to a leaf or take it as a parameter or a hook (`onTransition` in `job/store.ts`), rather than adding an upward import.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `config/` | `.forge/config.yml`: loading over the defaults, validation, and the one write path. |
| `errors.ts` | ForgeError, the CLI's error codes and the exit each code fixes. |
| `format/` | File and terminal formats Forge reads and writes itself, with no dependencies: YAML, zip archives and ANSI styles. |
| `glob.ts` | The globs specs and the protected-paths policy name, matched against repo-relative paths. |
| `job/` | The job store and what it persists: job.json, events and the lease, schema versions and migrations, requests, archives and session files. |
| `os/` | OS helpers on Node built-ins: the platform tiers, child processes and pids, small file reads and writes, and the mkdir lock. |
| `paths.ts` | Where things live on disk: the main checkout's root, the `.forge/` layout, job dirs and the plugin's own root. |
| `shape.ts` | Shape helpers every validator and state writer shares: one definition each, so the prototype-key guards can't drift between copies. |
| `text.ts` | Small text helpers: redaction, safe refs and outside text, slugs, CLI value coercion, shell words, templates, fences and tails. |
| `types.ts` | Shared data shapes of the engine, type-only: engine modules import these with `import type`, so this file never runs. |
| `utils.ts` | Small leftovers with no better home: the current timestamp and a short random id. |
<!-- forge:map:end -->
