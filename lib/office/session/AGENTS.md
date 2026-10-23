# lib/office/session/

One supervised headless Claude Code session (`createSession`), split further in #416.

- `lifecycle.ts` is pinned in `test/invariants/file-size.test.ts`; #416 splits it into this folder and `lib/integrations/claude/` (docs/design/lib-layout.md).
- A session runs with the repo as cwd, so its executable is a bare `claude` or an absolute path, never a relative one (docs/ARCHITECTURE.md "Daemon security").

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `lifecycle.ts` | One supervised headless session. |
<!-- forge:map:end -->
