# lib/core/versions/

The version lists: one append-only list of named steps per persisted shape, whose length plus one is that shape's version. `lib/core/job/schema.ts` runs them and re-exports the versions, except the machine index's (`machine.ts`), which `lib/engine/project/machine-index.ts` runs, the mandates' (`mandate.ts`), which `lib/office/mandates/store.ts` runs (through `contract.ts`'s `storedMandate`), a goal mandate's milestone draft's (`draft.ts`), which `lib/office/mandates/draft.ts` runs (`readDraft`), an approved draft's filing record's (`filing.ts`), which `lib/office/mandates/filing.ts` runs (`readFiling`), a closed mandate's summary's (`mandate-summary.ts`), which `lib/office/mandates/pass.ts` reads (`readSummary`), the prompt history's (`prompt-history.ts`), which `lib/office/session/permissions/history.ts` reads (`readPromptHistory`), and an overlap report's (`overlap.ts`), which `lib/engine/project/overlap.ts` reads (`readOverlapReport`); the `/api` list is `lib/api/versions.ts`.

- **Append only.** A shape change appends one step at the end of its list. Never edit, reorder or remove an entry: behaviour fixes to an old step are rare, and need its row in `test/schema.test.ts` updated.
- Each entry starts on its own line as `  { id: '<kebab-id>'` (two-space indent), which the release notes count (`scripts/release.ts`).
- Ids are unique per list, kebab-case, at most 60 characters (`stepProblems` in `steps.ts`).
- The version is the list's length + 1, never a typed number.
- Add one row per step in `test/schema.test.ts`, keyed by the step id.
- A config or job step needs its doc line (a `**Migration**` note in docs/CONFIG.md, a paragraph in docs/architecture/versioning.md), and so does an `API_CHANGES` step; `test/invariants/version.test.ts` names a missing one.
- On conflict keep both, in merge order: the base branch's entries first, then the job's. If both sides used the same id, rename the job's entry and its row.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `chat.ts` | The chat version steps: a chat's chat.json `schemaVersion` (`.forge/runtime/chats/<id>/chat.json`) is CHAT_STEPS' length plus one, and a log.jsonl line's `v` is CHAT_LOG_STEPS' length plus one. |
| `config.ts` | The config version steps: `.forge/config.yml`'s schemaVersion is this list's length plus one. |
| `draft.ts` | The milestone draft version steps: a goal mandate's draft.json `schemaVersion` (`.forge/runtime/mandates/<id>/draft.json`) is this list's length plus one. |
| `event.ts` | The event version steps: an events.jsonl line's `v` is this list's length plus one. |
| `filing.ts` | The filing record version steps: an approved milestone draft's filing.json `schemaVersion` (`.forge/runtime/mandates/<id>/filing.json`) is this list's length plus one. |
| `job.ts` | The job version steps: job.json's schemaVersion is this list's length plus one, with the helpers the steps need. |
| `machine.ts` | The machine index version steps: `<FORGE_HOME>/projects.json`'s schemaVersion is this list's length plus one. |
| `mandate-summary.ts` | The closing summary version steps: a closed mandate's summary.json `schemaVersion` (`.forge/runtime/mandates/<id>/summary.json`) is this list's length plus one. |
| `mandate.ts` | The mandate version steps: a mandate file's `schemaVersion` (`.forge/runtime/mandates/<id>.md`) is this list's length plus one. |
| `overlap.ts` | The overlap report version steps: a `forge overlap` report's `schemaVersion` (`.forge/runtime/overlap/jobs/<id>.json`, `.forge/runtime/overlap/prs/<n>.json`) is this list's length plus one. |
| `prompt-history.ts` | The prompt history version steps: a `.forge/runtime/permission-prompts.jsonl` line's `v` is PROMPT_HISTORY_STEPS' length plus one. |
| `steps.ts` | Version steps: a shape's version is its append-only list of named steps, length plus one. |
<!-- forge:map:end -->
