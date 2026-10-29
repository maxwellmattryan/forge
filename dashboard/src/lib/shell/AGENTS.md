# dashboard/src/lib/shell/

The frame around every page: the hash router, the sidebar's pages and rail, the project switcher and Add project dialog, the command bar and palette, and the status bar.

- `routes.ts` checks a route's project segment raw, never decoded, against `PROJECT_NAME` before anything uses it.
- `nav.ts`'s `VIEWS` is the page list `scripts/render-check.ts` and `scripts/scenario.ts` import, so a new page shows up in the render check.
- Each `.svelte.ts` holds one shared open state and its focus return; its rules live in the plain `.ts` beside it, which the tests pin.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `add-project.svelte.ts` | The Add project dialog's open state and focus return: the project switcher opens it, App.svelte mounts it and closes it on Escape, and the dialog closes itself. |
| `add-project.ts` | The Add project dialog's logic: the body it posts to POST /api/projects, where the server's reply leads, and the POST. |
| `command.ts` | The command bar's grammar, completions, keyboard rule and request mapping: plain functions over the dashboard's state, so node:test can pin them. |
| `nav.ts` | The sidebar's pages (the machine's global pages and each project's views), their order and the nav's badge counts. |
| `palette.svelte.ts` | The command palette's shared open state, job scope, starting text and focus return: App.svelte, CommandBar, the status bar and the drawer's CommandTrigger use it, so every trigger (the status bar's input, or its button below md; Cmd/Ctrl-K; the drawer) opens the same palette. |
| `rail-tip.svelte.ts` | The compact rail's one tooltip: a rail control shows its name on hover or focus, and RailTip.svelte draws it. |
| `routes.ts` | The hash router: `#/overview` and `#/machine` (global pages, which keep the selected project) and `#/p/<project>/<view>`. |
| `sidebar.ts` | The sidebar's width, its icon-only rail and the separator's keyboard rules, as plain functions node:test can pin. |
| `statusbar.ts` | The status bar's pure half: its Foreman, Workers and Inbox indicators and their lamps, the facts strip's drop order, the model label, the connection state, the prompt announcement, and the rule of the sidebar's "New job or command" input. |
| `switcher.ts` | The machine's registered projects as the project switcher, the Overview, the Machine page, the command bar and the Add project dialog show them. |
<!-- forge:map:end -->
