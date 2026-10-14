# Drafting job surfaces: cards, chips, progress, boards, tables and logs

Size: L · Needs design: yes (reference: `design/components/`) · Suggested reviewers: code, tests, ui, accessibility, ux

## Goal
Move everything that shows a job to the Drafting markup and tone map, then remove the temporary aliases from job 1 so the old class names are gone.

## Behaviour
- Tones: `TONE_CLASS` gains `live` (ink over hatching) and `rev` (rounded red callout); `stateTone` returns `live` for running states and `rev` for every state `needsHuman()` is true for; verdict `PASS` → `ok`, `CHANGES` → `bad`, pending → `muted`; PR merged `ok`, conflicts `warn`, checks failing `bad`.
- `JobCard`: a clickable ticked sheet; a job that needs a human is a `redline` sheet with a `REV · <state>` tag instead of a state chip; footer with round, the running role after an ink dot, and `<tokens> tok · <ago>` right-aligned.
- `InboxCard`: `redline` sheet, title button, `REV` tag, reason, link, note textarea, verbs (first `primary`).
- `ProgressBar` and budget bars: `track` > `fill` (hatched ink with the end tick); budget fills `ok|warn|bad`.
- Board columns: `sheet dashed`, `label` header, dashed rule; empty column shows `—`.
- `Empty`: `sheet crosshatch` with the `mark`; `DepSection`, `DepChips`, `DaemonBar`, `ThreadPanel` items, `SessionLog` controls and pane, `Kpi` tiles and every `.tbl` (JobsTable, CompareTable, Analytics, Drawer matrices) per their previews.
- `.prose` replaces `.prose-md` in the drawer's markdown view.
- The aliases added in job 1 (`card`, `btn-primary`, `kpi-label`, `kpi-value`, `prose-md`, `ember-bar`, `brand-rule`) are removed from `style.css`.

## Acceptance criteria
- [ ] AC1 — Each component matches its preview in both themes: JobCard (normal and needs-you), InboxCard, ProgressBar, BoardColumn, Empty, DepSection, DaemonBar, ThreadMessage, SessionLog, Kpi, Table · Proven by: ui lens screenshots `screenshots/ui-<component>-<theme>.png`.
- [ ] AC2 — `stateTone`, `verdictTone` and `prChipModel` return the tones above for every state in `types.ts` · Proven by: unit tests in `test/` over `src/lib/view.ts` (extend the existing ones).
- [ ] AC3 — Status chips in both themes clear 4.5:1 for their text on `--bg`, `--panel` and `--raised` · Proven by: the contrast test from job 1 extended to chip tones.
- [ ] AC4 — No old utility name (`card`, `btn-primary`, `kpi-label`, `kpi-value`, `prose-md`, `ember-bar`, `brand-rule`, `nav-item.active` inset shadow) remains in `dashboard/src/**` or `style.css`, and no `rounded-*` except `rounded-full` on dots · Proven by: the grep test from job 3, extended.
- [ ] AC5 — Markdown rendering stays escape-first (`md()` output unchanged; `{@html}` only where AGENTS.md allows) · Proven by: `test/dashboard-svelte.test.ts` and the existing markdown tests.
- [ ] AC6 — At 390px the board scrolls horizontally in 276px columns, tables scroll inside their sheet, cards don't clip · Proven by: ui lens screenshots at 390px.
- [ ] AC7 — Build, typecheck, i18n and dist tests pass · Proven by: verify.

## Out of scope
Appearance preferences and the README screenshots (job 5).

## Approach
Touch `JobCard`, `InboxCard`, `DepChips`, `DepSection`, `ProgressBar`, `Empty`, `DaemonBar`, `ThreadPanel`, `SessionLog`, `JobsTable`, `CompareTable`, `IssueLinkActions`, `JobActions`, the `kpi`/`usageTable` snippets in `views/Analytics.svelte`, the board in `views/Pipeline.svelte`, `views/Inbox.svelte`, `views/Agents.svelte`, `views/Evals.svelte`, `views/Backlog.svelte`, the drawer's tables and markdown view, `src/lib/budget.ts` and `src/lib/screenshots.ts` (their HTML strings use the new classes), `src/lib/util.ts` (`TONE_CLASS`), `src/lib/view.ts` (tones), `style.css` (alias removal). Keep `drafting.css` and `style.css` in step for any rule you adjust.

## Design references
`design/components/{JobCard,InboxCard,ProgressBar,BoardColumn,Empty,DepSection,DaemonBar,ThreadMessage,SessionLog,Kpi,Table,Chip}/`.
