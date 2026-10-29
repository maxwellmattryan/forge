# dashboard/src/components/shell/

The frame around every page: the sidebar and its project switcher, the Add project dialog, the command bar, the rail's tooltip, a view's title row and the status bar.

- The router, the sidebar's pages, the project switcher's model and the palette live in `src/lib/shell/`; `App.svelte` mounts the rest around the view, and every view and its skeleton import `PageHeader.svelte` themselves.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AddProject.svelte` | The Add project dialog: registers a repo through POST /api/projects (lib/shell/add-project.ts), then selects it and opens its Project page. |
| `CommandBar.svelte` | The command bar (Cmd/Ctrl-K): a modal ARIA combobox that starts a job from free text, sends a /forge-style command or opens a project (`project <name>`; with no project selected that is all it does). |
| `Nav.svelte` | The sidebar's two sections: General (the Overview, then, with a project selected, its Office and Foreman, then the Machine page: GENERAL_NAV), then the project section, which is the project switcher and, with a project selected, its other view links. |
| `PageHeader.svelte` | A view's title row: a riveted plaque holding the heading, an optional stamp line, and right-hand controls. |
| `ProjectSwitcher.svelte` | The project switcher over the machine's registered projects (lib/shell/switcher.ts): in the expanded sidebar a select-only combobox (`field`), in the phone strip its small button (`phone`), and on the rail an icon button that opens the palette with `project ` typed, which lists the projects (`rail`). |
| `RailTip.svelte` | The compact rail's tooltip: the hovered or focused control's name, 8px right of it on a solid plate. |
| `StatusBar.svelte` | The status bar: one slim fixed row at the bottom of every view. |
| `statusbar/` | The status bar's popover bodies: Needs you with its Shelved and Timed out lists, Workers, the Foreman, the inbox session, Models and Connection. |
<!-- forge:map:end -->
