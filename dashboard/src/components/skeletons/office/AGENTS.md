# dashboard/src/components/skeletons/office/

The Office and Foreman pages' loading shapes.

- Bones only, shaped like the real page, wrapped in one `Loading`. The Office skeleton shares the page's layout classes (`src/lib/office/layout.ts`).
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `ForemanDirectivesSkeleton.svelte` | The Office page's directives table while it loads: the real column headers over rows of bones. |
| `ForemanMandatesSkeleton.svelte` | The Office page's mandate list while it loads: two cards shaped like MandateCard (title, id and state chip, a line of scope terms, the progress block, the contract fold, an action row). |
| `ForemanSkeleton.svelte` | The Foreman view's shape while the project's first state loads (App.svelte): the header, then the chat list beside the open chat, as ChatsPanel lays them out. |
| `OfficeSkeleton.svelte` | The Office view's shape while the project's first state loads (App.svelte): the header, then OfficePanel's columns (lib/office/layout.ts) with the same headings: the mandates and directives on the left, the office session on the right. |
<!-- forge:map:end -->
