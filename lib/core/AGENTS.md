# lib/core/

Foundations with no pipeline policy: shared shapes, the job store and schema, config, paths, errors, and OS and text helpers.

- Shapes live in their module's `types.ts`, type-only: import them with `import type`. `types.ts` here is the transitional barrel: it re-exports `lib/api/types.ts`, `job/types.ts` and `config/types.ts`, and declares the tracker contract. A shape a higher layer owns is imported from that module's `types.ts`, never through this barrel.
- `errors.ts` imports nothing local and `utils.ts` nothing at all, so every module can use them. `os/` and `format/` stay leaves too: Node built-ins and OS process tools live here, never the repo's own configured commands (those are `engine/`).
- When a module here needs something from a higher layer, move the shared piece down to a leaf or take it as a parameter or a hook (`onTransition` in `job/transitions.ts`), rather than adding an upward import.
- Design: [Data and versioning](../../docs/architecture/versioning.md), [Concurrency](../../docs/architecture/concurrency.md).

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
| `types.ts` | The transitional type-only barrel: the /api/* and SSE shapes (lib/api/types.ts), the job shapes (lib/core/job/types.ts) and the config shapes (lib/core/config/types.ts), re-exported so older `#core/types.ts` imports keep compiling, plus the tracker contract. |
| `utils.ts` | Small leftovers with no better home: the current timestamp and a short random id. |
| `versions/` | The version lists: one append-only list of named steps per persisted shape, whose length plus one is that shape's version. |
<!-- forge:map:end -->
