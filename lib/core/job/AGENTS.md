# lib/core/job/

The job store and what it persists: job.json, events and the lease, schema versions and migrations, requests, archives and session files.

- `store.ts` holds job state and events, and the job lease: claim, renew, expire, the epoch fence. The CLI is the only writer of this state: new state means a new CLI command, never an agent editing `job.json`.
- `schema.ts` holds the versions, normalisers and migrations. Every shape change bumps its constant there with a migration keyed by the old version and a row in `test/schema.test.ts`; only one in-flight change may bump each constant.
- `fields.ts` holds the job-field rules `setJob` enforces for every caller.
- **Issue refs** live in `job.issues` (`issue-ref.ts`): GitHub refs are stored qualified (`owner/repo#12`), local refs are title slugs, custom refs are the adapter's own. Only `nativeRef` output reaches a tracker call. Job ids: this repo's GitHub issue gives `<n>-<slug>`, a foreign `owner/repo#n` gives `repo-<n>-<slug>`, any other ref is the ref itself slugified.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `archive.ts` | The read side of retention: archive records in `.forge/archive/<id>.json`, which keep a finished job's job.json, events and a summary after its directory is deleted. |
| `fields.ts` | The rules for the job fields setJob writes: which keys are locked to their owning command, which lists must hold strings, and which values `complexity` and `kind` may take. |
| `focus.ts` | Focus: which job the human at the keyboard is QA-ing. |
| `issue-link.ts` | A job's issue link: the pure half. |
| `issue-ref.ts` | A job's issues are tracker-neutral, repo-qualified refs (`owner/repo#12`, `KEY-123`, a backlog slug). |
| `lens.ts` | Review lens names. |
| `requests.ts` | A small file-based inbox. |
| `schema.ts` | Versioned data shapes. |
| `session-files.ts` | The daemon's session records and logs under .forge/runtime/daemons/, opened without following links or blocking on a FIFO. |
| `store.ts` | Job state and its event log: load, update and list jobs, and the job lease (claim, renew, expire, the epoch fence). |
<!-- forge:map:end -->
