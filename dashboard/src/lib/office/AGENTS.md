# dashboard/src/lib/office/

The Office and Foreman pages: mandates, report cards, milestone drafts, gate runs, the page layout and the chats.

- Mandate, directive, request, chat and gate-run text is owner, session or tracker text: these return plain strings, never markup.
- A draft's POST carries the request and digest of the draft the card rendered, so the server decides exactly what was shown.
- `layout.ts` holds whole class literals so Tailwind's `@source` scan sees every one.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `chats.ts` | The Foreman page's chats model: a chat log as owner, note and reply blocks, the forge CLI calls in a reply, each block's and item's plain text for Copy, which chat to open, and the GETs and POSTs of /api/chats (lib/server/routes/chats.ts). |
| `drafts.ts` | A goal mandate's milestone draft as the Needs-you card shows it: its issues by wave, the actions its gate offers, and the GET and POST of /api/mandates/:id/draft (lib/server/routes/mandates.ts). |
| `foreman.ts` | The Office page (#/p/<project>/office): its mandates, pending gates and directives, the editor's POST bodies, the mandate badge on a job, and the GETs and POSTs of /api/mandates (lib/server/routes/mandates.ts). |
| `gate-runs.ts` | The Foreman popover's gate activity list, its pure half: /api/state's DaemonPoolState.gates as rows, newest first (the 50 kept), and the list's header. |
| `layout.ts` | The Office page's layout classes, shared by the page (views/Office.svelte, components/office/OfficePanel.svelte) and its skeleton so the two hold the same shape. |
| `report-card.ts` | The Office page's report card model: which card a mandate shows (the live one, or a closed mandate's closing summary card when the server sent one), how one figure renders (a value, pending, or nothing to measure, never 0 for either), and the interventions by gate in WAITING_ON order then none. |
<!-- forge:map:end -->
