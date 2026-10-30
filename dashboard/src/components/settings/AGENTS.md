# dashboard/src/components/settings/

The settings modal and its tabs: General, the config sections, Diagnostics and About.

- `SettingsModal.svelte` creates one `src/lib/settings/session.svelte.ts` per open, so drafts survive tab switches and are gone once it closes.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AboutTab.svelte` | Settings › About: versions from GET /api/about, and links to the repository and docs. |
| `ConfigFieldRow.svelte` | One config field: label, key, help and default, then its control (or its read-only value) and any error. |
| `ConfigTab.svelte` | Settings › a config section: its fields from GET /api/config, and the Save bar that writes them through POST /api/config. |
| `DiagnosticsTab.svelte` | Settings › Diagnostics: forge doctor's checks through GET /api/doctor, a plain-text report to copy, and the redacted support bundle (GET /api/doctor/bundle). |
| `GeneralTab.svelte` | Settings › General: the dashboard's appearance, language and keyboard, kept per browser. |
| `SettingsModal.svelte` | The settings modal: a labelled, focus-trapped dialog with a tab rail. |
<!-- forge:map:end -->
