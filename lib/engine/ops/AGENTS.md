# lib/engine/ops/

Operating Forge itself: doctor, support bundles, updates, versions, retention, deletion, audit, repo detection and titles.

- `detect.ts` suggests review lenses for a repo; a new lens offered at init also goes in `skills/forge/reference/init.md`'s presets.
- A support bundle is shared outside the machine, so everything in it goes through redaction first.
- Design: [Updating](../../../docs/architecture/updating.md), [Retention](../../../docs/architecture/retention.md), [Deleting a job](../../../docs/architecture/deleting-a-job.md), [Audit trail](../../../docs/architecture/audit-trail.md), [Release security](../../../docs/architecture/release-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `audit.ts` | The audit trail export: who did what to a job, and when its gates opened and closed. |
| `bundle.ts` | The support bundle: `forge doctor --bundle` and GET /api/doctor/bundle. |
| `dashboard-record.ts` | The running dashboard's record (`.forge/runtime/dashboard.json`), proven before anyone signals its pid or shows its URL. |
| `delete.ts` | `forge job delete`: removes a job that should never have existed (a mistaken start, a duplicate) and everything Forge made for it, keeping no archive record, so stats and retro never count it. |
| `detect-components.ts` | Component suggestions for `forge init detect`: one per npm/yarn/pnpm/bun workspace package, Cargo workspace member and CMake subproject, with the build edges their manifests make obvious. |
| `detect.ts` | Inspects a repository so `/forge init` can propose answers instead of asking blind questions. |
| `doctor.ts` | `forge doctor` and GET /api/doctor: is this machine and repo ready for Forge? |
| `retention.ts` | Retention: archive finished jobs into compact records, delete stale daemon session logs, and apply the human's `retention` policy. |
| `title.ts` | Short, deterministic job titles from free text (POST /api/jobs). |
| `types.ts` | What the audit, support-bundle, update, version, archive and prune commands print, type-only. |
| `update.ts` | `forge update`: update the Forge install that is running, whether Claude Code installed it as a plugin or it is a git clone (npm link, --plugin-dir). |
| `version.ts` | `forge version --json`: which Forge is running, down to the commit, so an install can be pinned, audited and rolled back (docs/RELEASES.md "Provenance and pinning"). |
<!-- forge:map:end -->
