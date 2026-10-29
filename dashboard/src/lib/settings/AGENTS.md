# dashboard/src/lib/settings/

The settings modal and the browser's preferences.

- `prefs.ts` keys a pref per project (`forge.p/<project>/<key>`) unless it is in `MACHINE_PREFS`: add a new pref there when it belongs to the browser, not a project.
- The config form's errors are message keys in `messages/en/settings.json`, never prose.
- `session.svelte.ts` lives for one open of the modal, so drafts survive tab switches and go when it closes.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `config-form.ts` | The settings form's model: field values as editable drafts, drafts parsed back into config values, and which keys a Save would write. |
| `diagnostics.ts` | The Diagnostics tab's report: plain text for the clipboard, never HTML. |
| `modal.ts` | The settings modal's keyboard and focus rules, as plain functions node:test can pin. |
| `prefs.ts` | UI preferences in localStorage: the machine's as `forge.<key>`, every other one per project as `forge.p/<project>/<key>`. |
| `session.svelte.ts` | One open of the settings modal: the config form's data and drafts, and the Diagnostics and About fetches. |
<!-- forge:map:end -->
