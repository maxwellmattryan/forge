# .factory

State and configuration for the software factory (https://github.com/maxwellmattryan/factory).

| Path | Tracked | What |
|---|---|---|
| `config.yml` | yes | Factory configuration (`/factory init` writes it; docs/CONFIG.md in the plugin explains every key) |
| `backlog.md` | yes | Local backlog when `tracker.kind: local` |
| `notes/learnings.md` | yes | Lessons every agent reads; maintained by `/factory retro` |
| `notes/<role>.md` | yes | Optional per-role addenda (e.g. `builder.md`) |
| `reviewers/<name>.md` | yes | Repo-specific reviewer checklists (override or extend the plugin catalog) |
| `evals/` | yes | Eval tasks and run results |
| `trackers/<name>.mjs` | yes | Custom tracker adapters |
| `jobs/`, `locks/`, `runtime/` | no | Runtime state |

Dashboard: `factory dash` (or `/factory dash`).
