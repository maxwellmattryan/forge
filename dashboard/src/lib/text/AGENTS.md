# dashboard/src/lib/text/

The words and markup the dashboard shows: message lookup and the locale store, the escape-first markdown renderer, and the Rendered/Raw choice.

- `md()` in `markdown.ts` is the only `{@html}` builder, and `safeUrl` there is the only door for a dynamic URL. `test/invariants/dashboard-invariants.test.ts` pins both imports to this file's path: moving it means moving the guard too.
- Components import `t` from `locale.ts` and write `$t('literal.key')`; `i18n.ts` stays svelte-free so the tests and `scripts/scenario.ts` can import it.
- Don't add a markdown library or any `innerHTML`.
- Design: [Working on the dashboard](../../../AGENTS.md), [Dashboard security](../../../../docs/architecture/dashboard-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `i18n.ts` | The dashboard's message lookup: plain functions over JSON catalogs, so node:test can pin them. |
| `locale.ts` | The locale store layer over i18n.ts. |
| `markdown.ts` | Markdown for job files and tracker text, escape-first, so agent- or issue-supplied HTML never executes. |
| `md-view.svelte.ts` | The Rendered/Raw choice per surface, saved as `forge.mdView.<surface>`. |
| `md-view.ts` | Which surfaces render markdown, and how a saved Rendered/Raw choice reads back. |
<!-- forge:map:end -->
