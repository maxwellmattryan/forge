# Drafting iconography: 23 line icons and icons on the settings rail

Size: S · Needs design: yes (reference: `design/icons/`) · Suggested reviewers: code, tests, ui, accessibility

## Goal
Replace the dashboard's 13 stroke icons with the Drafting set of 23 and draw them the Drafting way, so navigation, the settings rail and every control carry the same line.

## Behaviour
- `Icon` renders at 1.25px stroke, round caps and joins, 18px in navigation and 15px in buttons; construction geometry (the dashed pitch circle on the cog, the centre line under the chart, the circle around close and plus) renders dashed 2/2 at 60% opacity and takes the same colour.
- The settings dialog's rail shows an icon before every tab label (general, pipeline, review, agents, tracker, dashboard, daemon, diagnostics, about), on desktop and in the phone strip.
- `search`, `play`, `stop`, `copy`, `refresh` are available for toolbars (Start/Stop in the daemon bar and session log use play/stop).

## Acceptance criteria
- [ ] AC1 — `src/lib/icons.ts` defines exactly the 23 names in `design/icons/` and each name's geometry matches its SVG file · Proven by: a test that parses each `design/icons/<name>.svg` and compares the path data and construction segments to `ICONS[name]`.
- [ ] AC2 — `Icon.svelte` renders `stroke-width="1.25"`, round caps/joins, and construction segments as `stroke-dasharray="2 2"` at `opacity=".6"` · Proven by: a Svelte render test.
- [ ] AC3 — Every settings tab shows its icon with the label, and the rail keeps `role="tablist"` semantics and the 44px targets on phones · Proven by: ui + accessibility lens screenshots `screenshots/ui-settings-rail-<theme>.png`.
- [ ] AC4 — Nav, rail, command button and daemon-bar icons inherit colour from their text (`muted` at rest, `fg` active, `ink` live) · Proven by: ui lens screenshots in both themes.
- [ ] AC5 — Build, typecheck, i18n and dist tests pass · Proven by: verify.

## Out of scope
Any other markup change (jobs 3–4).

## Approach
- `ICONS` becomes `Record<IconName, { d: string; cx?: string }>` (main path data and optional construction data; a file-backed test keeps it honest) or, simpler, the inner SVG string per name as in `design/icons/*.svg`; pick one and apply it in `Icon.svelte` via a tiny template, not `{@html}` (the escape rule in AGENTS.md).
- `SETTINGS_TABS` in `src/lib/settings.ts` gains `icon: IconName`; `Settings.svelte` renders `<Icon name={item.icon} />` inside each tab button's label span, matching `Nav.svelte`.
- `design/icons/README.md` documents the drawing rules; `README.md` › Dashboard needs no change.

## Design references
`design/components/Icon/preview.html`, `design/icons/`, `design/components/SettingsDialog/preview.html`.
