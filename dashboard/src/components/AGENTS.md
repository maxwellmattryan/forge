# dashboard/src/components/

The dashboard's Svelte components, in folders by feature area, with the primitives every area shares in `ui/`.

- A new component goes in the folder for its feature area, or in `ui/` when two or more areas use it. It never goes at this root.
- Each component opens with a `<!-- … -->` header whose first sentence says what it shows, has a PascalCase name, and stays under 600 lines. Each row below is a folder's first sentence or a component's header: edit those, then run `npm run docs:map`.
- Folders hold 3–12 entries. There are no index files, and no name equals its folder's (`test/invariants/dashboard-layout.test.ts`). Names keep their feature word (`JobCard`, `SessionLog`), because import bindings equal file names.
- Imports keep the `.svelte` extension: `./X.svelte` inside a folder, `../<folder>/X.svelte` across folders. Logic you want tested goes in `src/lib/<module>/`.
- Design: [Working on the dashboard](../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `drawer/` | The drawer: its shell, the job panel and the issue panel, and the job panel's header controls, Agents tab and Thread. |
| `gates/` | What waits on a person and the answers they give: the Needs-you cards, a gate's note and request buttons with the issue-link and repo-proposal answers, the drawer's action dock and the repo budget hold. |
| `jobs/` | A job on the board: its card and table row, the chips, stepper and bar they show, and the effort dropdown. |
| `logs/` | Session and environment logs as the station shows them: a session's log and its items, an environment's log and the pilot lamp. |
| `metrics/` | Usage and cost: a job's budget chip, cell and panel, Analytics' period meter, the Overview's stacked bars and the Evals compare table. |
| `office/` | The Office and Foreman pages: the Office panel, the mandate badge, card, editor and report card, and the chats. |
| `sessions/` | Daemon sessions as the board and the drawer show them: activity lines, controls and the Start/Stop toggle, the live dot, the lease chip, running agents and permission prompts. |
| `settings/` | The settings modal and its tabs: General, the config sections, Diagnostics and About. |
| `shell/` | The frame around every page: the sidebar and its project switcher, the Add project dialog, the command bar, the rail's tooltip, a view's title row and the status bar. |
| `skeletons/` | Each page's loading shape, grouped like the pages, built from `ui/feedback/`'s Loading and Skeleton. |
| `ui/` | The primitives every feature uses: chips, icons, icon and close buttons, the select, copyable text, field hints, count badges, the Rendered/Raw toggle, and the feedback and overlay sets. |
<!-- forge:map:end -->
