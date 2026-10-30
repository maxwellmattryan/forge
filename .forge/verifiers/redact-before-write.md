---
paths: [lib/**/*.ts]
severity: major
mode: warn
---
Does all text this diff writes to a file, an event, a log or an /api response that came from a transcript, a shell command line, tool input, a permission rule or process output go through `redactKnown`, `redactDeep` or `redactText` first?

- The helpers: `redactKnown` and `redactDeep` in `lib/engine/guard/known-secrets.ts`, `redactText` in `lib/engine/guard/redact.ts`.
- Command lines and tool input carry secrets inline (`PGPASSWORD=… psql`, `DATABASE_URL=postgres://u:pw@…`), and a permission rule can be the whole command.
- Patterns to copy: `lib/office/session/permissions/history.ts` and `lib/engine/evals/retro.ts` redact before they write; `lib/server/redact.ts` before serving.
- Answer YES for text Forge composes from fixed strings, ids, counts, hashes and paths it built itself.
