# Drafting shell: sidebar, page headers, navigation, dialogs and drawer

Size: L · Needs design: yes (reference: `design/components/`) · Suggested reviewers: code, tests, ui, accessibility, ux

## Goal
Move the dashboard's shell to the Drafting markup: the sidebar becomes a drawing's margin with a title block, page headers carry a dimension line, controls become drawn segments and tabs, and the overlays become stacked sheets.

## Behaviour
- Sidebar (`App.svelte`): a ticked brand sheet (the mark as a one-colour print, *Forge* in `sheet-title`, *software factory* in `label`), a dimension line reading `DWG · <VIEW>` for the active view, the repo line, the dashed ⌘K button, the nav, and at the foot the Settings item and a title block with DRAWN BY `forge`, SESSIONS `<n> active` (with the ok dot), REV `v<version>`, API `<n>`, SHEET `<View> · <i> of 6`. The phone header keeps the same items as a strip with 44px command/settings targets.
- `Nav.svelte`: `nav`/`nav-item` rules; the inbox count is a `rev` chip, the pipeline count mono `muted`.
- `PageHeader.svelte`: the `sub` snippet renders inside a `dim-line` under the `h1`, uppercase mono between end ticks.
- Pipeline filters and the board/table toggle are `seg` strips of `btn sm`, the selected one `sel`; Analytics' window select is `input`.
- `Drawer.svelte`: `--shadow-drawer` edge, the chip row with the stage as an `ink` chip, `tabs`/`tab` strip, facts as `label` over `mono`.
- `Settings.svelte`: solid ticked sheet, `SHEET S-01` label beside the title, rail from job 2, section `callout`s, the footer's unsaved/error summary as a `rev` chip, `--shadow-dialog`.
- `CommandBar.svelte`: solid ticked sheet, active option with `raised` + 3px ink rule, the runnable row's glyph in `ink`.
- `Banner.svelte`: `sheet redline` with a `REV` chip; `Toast.svelte`: `sheet ticks solid` with `--shadow-dialog`, error text in `bad`.

## Acceptance criteria
- [ ] AC1 — Each component above matches its `design/components/<Name>/preview.html` in both themes: sidebar, NavItem, PageHeader, SegmentedControl, Tabs, Drawer, SettingsDialog, CommandBar, Banner, Toast · Proven by: ui lens screenshots `screenshots/ui-<component>-<theme>.png` set beside the preview.
- [ ] AC2 — New words (`DWG`, `SHEET`, `REV`, `DRAWN BY`, `SESSIONS`, `API`, `S-01`) come from `en.json`, and the title block's SHEET line names the active view and its index among the six · Proven by: i18n test; a unit test on the view-index helper in `src/lib/view.ts`.
- [ ] AC3 — Keyboard behaviour is unchanged: focus trap in dialogs, roving tabs on the rail, Escape closes, focus returns to the opener; every control shows the dashed focus ring · Proven by: accessibility lens, manual tab-through recorded in `review`.
- [ ] AC4 — At 390px the sidebar collapses to the strip, dialogs are full-width sheets, nothing clips · Proven by: ui lens screenshots at 390px.
- [ ] AC5 — No `rounded-*` class remains in the touched files except `rounded-full` on dots; no `shadow-lg`/`shadow-2xl` · Proven by: a grep test over `dashboard/src/**`.
- [ ] AC6 — Build, typecheck, i18n and dist tests pass · Proven by: verify.

## Out of scope
Job cards, chips' tone map, progress bars, board columns, tables, KPIs, empty states, daemon bar, thread, session log (job 4); appearance preferences (job 5).

## Approach
Touch `App.svelte`, `Nav.svelte`, `PageHeader.svelte`, `views/Pipeline.svelte` (controls only), `views/Analytics.svelte` (select only), `Drawer.svelte` (shell only: header, chips, facts, tabs), `Settings.svelte`, `CommandBar.svelte`, `Banner.svelte`, `Toast.svelte`, `messages/en.json`, and `src/lib/view.ts` for a `viewIndex(view)` helper. Use the utilities from job 1 as they are; if a rule is missing or wrong, fix it in `style.css` and in `design/drafting.css` in the same commit so the drawing stays true. The mark's one-colour treatment is the `mark` utility (blend per theme).

## Design references
`design/components/{Sidebar,NavItem,PageHeader,SegmentedControl,Tabs,Drawer,SettingsDialog,CommandBar,Banner,Toast}/`, `design/README.md` › Drawing conventions.
