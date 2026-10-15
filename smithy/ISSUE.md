# Restyle the dashboard: Smithy (iron, steel and one gleam) replaces Drafting

## Why

The Drafting direction (cyanotype blueprint, ticks, hatching) is fun but doesn't fit a *forge*. Smithy is a new design system for the same 27 component families: a smithy at night in gunmetal and brushed steel, plates cut at two corners like sheet iron and bevelled top and bottom, a fine film grain, one silver-blue accent (`gleam`, polished steel with a brushed gradient and a specular line) for the machine at work, and one warm colour (`ember`) reserved for work that waits on a person. Light theme: Ash.

The full system (brand book, tokens in both themes with contrast notes, the reference stylesheet, a README and a live preview per component, the icon set and the anvil mark) is attached as `smithy.zip`; `smithy/index.html` opens the previews, `smithy/MIGRATION.md` is the port plan.

## Scope

- [ ] Tokens: `tokens.css` into `dashboard/style.css`; theme ids `forge` / `ash`; renamed tokens per `MIGRATION.md` §1; Google-hosted or self-hosted Barlow Semi Condensed, Barlow, DM Mono
- [ ] Utilities: `smithy.css` → `@utility` blocks; class renames per the table in `MIGRATION.md` §2; `appearance: none` on button plates; grain on `.plate::after`
- [ ] Shell: command input moves to the sidebar; title block removed; status bar slims to 36px and carries the facts strip (`V0.15.0 · API 3 · SESSIONS ● 2 active · SHEET …`)
- [ ] Icons: `lib/icons.ts` and `Icon.svelte` take the machined set from `assets/Icons/`; drop the construction-mark branch; update `test/dashboard-icons.test.ts`
- [ ] Copy: `REV` → `YOU`; counts as `Label (N)`; Settings › Appearance = Forge / Ash / System + Grain; drop `DWG`, `SHEET S-01`
- [ ] Components restyled in place (no markup rebuild where the class map covers it): Button, SegmentedControl, Tabs, FormControls, Chip, LiveDot, ProgressBar, Banner, Toast, Card, Empty, Kpi, Table, PageHeader, NavItem, Sidebar, StatusBar (+ popovers), JobCard, BoardColumn, InboxCard, DepSection, ThreadMessage, SessionLog, Drawer, CommandBar, SettingsDialog, Icon
- [ ] `test/dashboard-shell.test.ts` "text never sits on the bare ground" still green; contrast pairs from the token notes hold in both themes
- [ ] Screenshots in `assets/screenshots/` and the README's badge colours refreshed; `design/` replaced by `smithy/`

## Acceptance

Both themes match the previews in `smithy/components/*/preview.html` at md and up and on a phone width; no plate paints outside its cut corner in Chrome, Safari or Firefox (a browser without `corner-shape` shows soft corners of the same size, which is fine); reduced motion stops the live dot's halo.
