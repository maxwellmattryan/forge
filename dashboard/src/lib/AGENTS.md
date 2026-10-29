# dashboard/src/lib/

The dashboard's plain-TS logic and rune state, in module folders grouped by concern.

- A new file goes in the module folder for its concern (`src/lib/<module>/`), never at this root. It opens with a header comment whose first sentence says what it holds, and stays under 600 lines. Folders hold 3–12 entries, with no `index.ts` and no name that repeats its folder (`test/invariants/dashboard-layout.test.ts`).
- Read a folder's `AGENTS.md` before working in it. Each row below is a folder's first sentence or a file's header comment: edit those, then run `npm run docs:map`.
- Imports keep their `.ts` / `.svelte.ts` extension: `./<file>.ts` inside a folder, `../<folder>/<file>.ts` across folders. Anything from the engine's `lib/` comes in with `import type` or `export type` only.
- Tests can't import `.svelte` or `.svelte.ts` (runes need the compiler), so logic you want tested lives in a plain `.ts`, with its `*.test.ts` beside it.
- Design: [Working on the dashboard](../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `core/` | The foundations every area imports: the app's state and actions, the `/api` types, shared helpers, the selected project, the login, display labels, request bodies and the shared clock. |
| `gates/` | What waits on a person and what they can do about it: the Needs-you inbox and its Shelved list, a decision in flight, the drawer's action dock, and the action cards' POSTs. |
| `jobs/` | A job as the board and the drawer show it: its state, card and table, dependencies, the drawer, effort, repos, screenshots, protected paths and its Thread. |
| `logs/` | Session logs: one raw line parsed, lines grouped into turns, a session's or a chat's log streamed, a station's lamp, and who a line comes from. |
| `metrics/` | Usage and cost: the Analytics, Evals and Overview pages, per-job and repo budgets, and agent runs' billing. |
| `office/` | The Office and Foreman pages: mandates, report cards, milestone drafts, gate runs, the page layout and the chats. |
| `project/` | The project around the jobs: its graph, environments and focus, and the Issues page. |
| `sessions/` | The daemon pool's sessions: pills and the pool summary, permission prompts, the Agents page, what a job's agents are doing, and the live board. |
| `settings/` | The settings modal and the browser's preferences. |
| `shell/` | The frame around every page: the hash router, the sidebar's pages and rail, the project switcher and Add project dialog, the command bar and palette, and the status bar. |
| `text/` | The words and markup the dashboard shows: message lookup and the locale store, the escape-first markdown renderer, and the Rendered/Raw choice. |
| `ui/` | Shared interface pieces: the icon set, the theme, motion, the sliding marker, the select's keyboard model, and the overlays. |
<!-- forge:map:end -->
