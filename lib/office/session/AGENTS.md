# lib/office/session/

One supervised headless Claude Code session (`createSession`), split further in #416.

- `lifecycle.ts` is pinned in `test/invariants/file-size.test.ts`; #416 splits it into this folder and `lib/integrations/claude/` (docs/design/lib-layout.md).
- A session runs with the repo as cwd, so its executable is a bare `claude` or an absolute path, never a relative one (docs/ARCHITECTURE.md "Daemon security").

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `contract.ts` | The session's contract with its pool: the events it reports, the context and options it is built with (sessionOptions fills in the real defaults), the child it supervises and the Session it returns. |
| `control.ts` | Every line the supervisor writes to claude's stdin, and the control channel: the one fixed turn, permission answers and mode switches. |
| `holds.ts` | What keeps a request or a turn waiting: a job parked on its budget, the repo budget, and the quota limits a failed turn reports. |
| `lifecycle.ts` | One supervised headless session. |
| `log.ts` | A session's log: `<scope>.log` on disk, the replay ring the dashboard reads, and the byte-capped splitting and stamping of the child's output lines. |
| `records.ts` | What a session record (`.forge/runtime/daemons/<scope>.json`) says about its child, and reaping the children a dead `forge dash` left behind. |
<!-- forge:map:end -->
