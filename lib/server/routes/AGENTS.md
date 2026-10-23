# lib/server/routes/

The dashboard's route handlers, one file per area; the route table in `lib/server/start.ts` maps each method and path to one of them and names its guards.

- Handlers start after their guards have passed and never call a guard themselves.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `config.ts` | Settings routes: the config view with webhooks masked, one config change, and the repo budget acknowledgement. |
| `environment.ts` | Environment routes: a job's dev server and backing services, their actions and logs, and every running environment. |
| `jobs.ts` | Job routes: create a job, its detail, files and raw mockups, requests, effort, delete, repo proposals, and its dev server and editor. |
| `misc.ts` | The other read routes and focus: /api/state, stats, evals, roster, project graph, backlog, about, doctor and its bundle, GitHub previews, and POST /api/focus. |
| `office.ts` | Session pool routes: the per-session event stream, the session log, start and stop, permission answers and permission modes. |
| `transcripts.ts` | Claude Code transcripts on the dashboard: locating a job's agent or owner transcript, its page and stream, and the agent rows and activity read from them. |
<!-- forge:map:end -->
