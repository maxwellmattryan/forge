# lib/server/routes/

The dashboard's route handlers, one file per area; the two route tables in `lib/server/start.ts` map each method and path to one of them and name its guards.

- Handlers start after their guards have passed and never call a guard themselves.
- A project handler gets that project's `ServerCtx` and reads only its `root`; a machine handler (the page, `/api/about`, `machine.ts`) gets the `MachineCtx`. A stream a project handler opens is keyed `${ctx.name}/<scope>` in the machine's `clients`.
- Design: [Dashboard security](../../../docs/architecture/dashboard-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `chats.ts` | Chat routes: the owner's chats with the Foreman. |
| `config.ts` | Settings routes: the config view with webhooks masked, one config change, and the repo budget acknowledgement. |
| `environment.ts` | Environment routes: a job's dev server and backing services, their actions and logs, and every running environment. |
| `jobs.ts` | Job routes: create a job, its detail, files and raw mockups, requests, effort, delete, merge now, repo proposals, and its dev server and editor. |
| `machine.ts` | The machine routes: GET /api/projects, the registered projects with their job counts, latest job, pools and the machine cap; its event stream, which sends that body on connect and again whenever it changes; and GET /api/projects/stats, each loaded project's shipped jobs and cost per UTC day for the Overview's graphs. |
| `misc.ts` | The other read routes and focus: /api/state, stats, evals, roster, project graph, backlog, about, doctor and its bundle, GitHub previews, and POST /api/focus. |
| `office.ts` | Session pool routes: the per-session event stream, the session log, start and stop, permission answers and permission modes. |
| `transcripts.ts` | Claude Code transcripts on the dashboard: locating a job's agent or owner transcript, its page and stream, and the agent rows and activity read from them. |
<!-- forge:map:end -->
