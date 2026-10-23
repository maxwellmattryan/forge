# lib/core/versions/

The version lists: one append-only list of named steps per persisted shape, whose length plus one is that shape's version. `lib/core/job/schema.ts` runs them and re-exports the versions; the `/api` list is `lib/api/versions.ts`.

- **Append only.** A shape change appends one step at the end of its list. Never edit, reorder or remove an entry: behaviour fixes to an old step are rare, and need its row in `test/schema.test.ts` updated.
- Each entry starts on its own line as `  { id: '<kebab-id>'` (two-space indent), which the release notes count (`scripts/release.ts`).
- Ids are unique per list, kebab-case, at most 60 characters (`stepProblems` in `steps.ts`).
- The version is the list's length + 1, never a typed number.
- Add one row per step in `test/schema.test.ts`, keyed by the step id.
- On conflict keep both, in merge order: the base branch's entries first, then the job's. If both sides used the same id, rename the job's entry and its row.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `config.ts` | The config version steps: `.forge/config.yml`'s schemaVersion is this list's length plus one. |
| `event.ts` | The event version steps: an events.jsonl line's `v` is this list's length plus one. |
| `job.ts` | The job version steps: job.json's schemaVersion is this list's length plus one, with the helpers the steps need. |
| `steps.ts` | Version steps: a shape's version is its append-only list of named steps, length plus one. |
<!-- forge:map:end -->
