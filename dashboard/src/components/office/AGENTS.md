# dashboard/src/components/office/

The Office and Foreman pages: the Office panel, the mandate badge, card, editor and report card, and the chats.

- Mandate, directive and chat text is owner or session text: it renders as text, or as markdown only through `md()`.
- The models and the page layout classes live in `src/lib/office/`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `MandateBadge.svelte` | A job's mandate as a chip on its board card and table row: the id as plain text (never a link, since the card is a button), titled "Mandate <id>". |
| `MandateCard.svelte` | One readable mandate on the Office page: its title, id, state and reason; its scope; its chain (with the active link marked) and what it waits on; its progress against its budget; its report card; the contract as it applies now and every line the config capped; its live jobs (each opens the drawer); its merge queue when it lists any open PR (each overlap group in merge order, then the merge-now and unchecked PRs; each id opens the drawer); a goal mandate's draft and gate, pointing at Needs you, which decides it. |
| `MandateEditor.svelte` | The mandate editor, in a centred modal (the Add project shell: backdrop, focus trap, Escape, scroll lock; a full-screen sheet below md): a new mandate's or one mandate's. |
| `OfficePanel.svelte` | The Office page's panel, in two columns where the view is wide enough (lib/office/layout.ts), stacked below that. |
| `ReportCard.svelte` | A mandate's report card on its MandateCard: one card only (shownCard: the live one, or a closed mandate's closing summary card), with a source line saying which. |
| `chats/` | The Foreman page's chats: the chat list, the open chat, its header and its composer. |
<!-- forge:map:end -->
