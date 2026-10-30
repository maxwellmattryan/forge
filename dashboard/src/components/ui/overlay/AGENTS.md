# dashboard/src/components/ui/overlay/

What floats over the page: the status bar's popover, the menu button, tooltips, the toast and the GitHub hover card.

- Each overlay's state lives in `src/lib/ui/overlay/`: a `.svelte.ts` holds the one open instance and its focus return, and a plain `.ts` holds the placement and close rules the tests pin.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `GitHubCard.svelte` | The GitHub hover card: any link to a github.com repository, pull request, issue or commit, anywhere in the dashboard (markdown included), or an element carrying `data-gh-href` (a board card's PR chip), shows one after a resting pointer or keyboard focus. |
| `MenuButton.svelte` | A small button that opens a non-modal dialog under it: the session log's Filter control. |
| `Popover.svelte` | A status bar popover: a non-modal dialog that sits --space-1 above the bar, anchored to its indicator at md and up and spanning the viewport less 16px on phones. |
| `Toast.svelte` | The toast; toast.svelte.ts drives it. |
| `Tooltip.svelte` | An icon-only button's visible name, in the dashboard's own style instead of the late native `title`. |
<!-- forge:map:end -->
