---
paths: [lib/**/*.ts]
severity: major
mode: warn
---
Does every value this diff passes into git argv that comes from job state, config, `gh` output or git output either pass a check that keeps it from reading as an option (`isSha`, `assertSafeRef`, a SHA regex) or come after `--`?

- job.json, config, tracker text and `gh` or git output are writable by the builder or by people outside the session, so a value that starts with `-` becomes an option to git (`--output=…`, `--upload-pack=…`).
- Patterns to copy: `isSha` and `assertSafeRef` in `lib/core/text.ts`, and the `--` before revisions and paths in `lib/engine/guard/integrity.ts`.
- Answer YES for literals, and for values this diff or their caller already checked.
- Config pins and diff options are held by `test/invariants/security-scan.test.ts`, not by this question.
