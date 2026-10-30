# dashboard/src/lib/ui/overlay/

What floats over the page: popovers, menus, tooltips, the toast, the GitHub hover card, and the scroll lock beneath them.

- Each overlay splits in two: a `.svelte.ts` holds the one open instance and its focus return, and a plain `.ts` holds the placement and close rules the tests pin.
- Any module can call `toast()` from `toast.svelte.ts`; `components/ui/overlay/Toast.svelte` renders it.
- `github.ts` only decides whether to ask for a card; the server parses the URL again (`lib/integrations/github/preview.ts`).
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `github-card.svelte.ts` | The GitHub hover card's one open card, its hover-intent timers and the answers fetched so far, like toast.svelte.ts for the toast: GitHubCard.svelte feeds it document events and renders it, and github.ts holds the rules. |
| `github.ts` | GitHub hover cards' pure rules: which links get a card, when it opens and closes, where it sits and how a preview's state reads. |
| `menu.ts` | Where a small menu popover (components/ui/overlay/MenuButton.svelte, components/ui/Select.svelte) opens, and where focus waits while a button's action runs, as plain functions node:test can pin. |
| `popover.svelte.ts` | The status bar's one open popover and its focus return, like shell/palette.svelte.ts for the palette: StatusBar's indicators open it, Popover.svelte and App.svelte close it, and popover.ts decides when it closes and where focus goes. |
| `popover.ts` | The status bar popovers' rules, pure like shellEscape: which one is open, when one closes and where focus goes, and where it sits. |
| `scroll-lock.ts` | The page under the drawer, a dialog or the palette does not scroll. |
| `toast-place.ts` | Where the toast sits, as a plain function node:test can pin: never over the board's primary controls, the job drawer's action dock or the status bar. |
| `toast.svelte.ts` | The toast's state and trigger: any module can call toast(); Toast.svelte renders it. |
| `tooltip.ts` | Where an icon button's tooltip (components/ui/overlay/Tooltip.svelte) opens, as a plain function node:test can pin. |
<!-- forge:map:end -->
