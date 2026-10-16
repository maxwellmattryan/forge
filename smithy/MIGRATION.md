# Porting Smithy into the dashboard

The dashboard currently ships the Drafting direction (`dashboard/style.css`: cyanotype / vellum / nightprint, Space Grotesk, IBM Plex, the grid and paper grain, ticked sheets, the hover sketch). Smithy replaces every one of those values with the files in this folder. The route is the one `design/MIGRATION.md` already describes, with these specifics.

## 1. Tokens

- Replace the `:root` / `[data-theme]` blocks copied from `design/tokens.css` with `tokens.css` here. Theme ids change: `cyanotype` → `forge` (the default), `vellum` → `ash`; `nightprint` is gone. `Settings › Appearance` offers Forge, Ash and System (System = Ash on a light OS, Forge on a dark one).
- Renamed tokens, in `@theme inline`: `ink` → `gleam`, `on-ink` → `on-gleam`, `redline` → `ember`, `highlight` → `spark` (+ `on-spark`), `sketch-line` → `sheen`; new: `gleam-hot`, `gleam-deep`, `edge-light`, `edge-dark`, `on-ember`. Removed: `grid-minor`, `grid-major`, `paper-opacity`, `hatch-pitch`, `tick`, `dash`. New scalars: `radius-cut` (10px), `radius-nick` (5px), `bar-rule` (3px); `stroke-icon` is 1.5px; `size-statusbar` is 36px.
- The Tailwind `@theme` overrides: `--radius-*` map to `radius-1` (2px) instead of 0; the blurred `--shadow-*` map to `shadow-overlay`.
- Fonts: `Barlow Semi Condensed` 600/700, `Barlow` 400/500/600 and `DM Mono` 400/500 are self-hosted woff2 under `dashboard/fonts/` (the dashboard loads nothing cross-origin; `dashboard/fonts/README.md` records their source); `--font-head`, `--font-sans`, `--font-mono` take the stacks from `tokens.json` › `type.families`. Type styles (`page-title` 32, `card-title` 15/600, `kpi-value` 28, the `stamp` style replacing `dim`) are in `tokens.css`.

## 2. Utilities

Port `smithy.css` into the `@utility` blocks of `dashboard/style.css`, name for name. The class vocabulary changes:

| Drafting | Smithy |
|---|---|
| `sheet`, `sheet ticks` + `<span class="tk">` | `plate` (no tick span) |
| `sheet dashed` (container) | `plate open` |
| `sheet redline` | `plate ember` |
| empty state (`sheet` + dashed) | `plate cold` |
| brand sheet, page header | `plate riveted` (square plaque, no cut) |
| `nav` | `navlist` (avoids the `nav` type style) |
| `dim-line` + `<span class="end">` | `stamp-line` (+ `wide`) |
| `tblock` | removed; facts move to the status bar as `.facts` |
| `chip rev` / `chip ink` / `chip hl` | `chip you` / `chip gleam` / `chip spark` |
| `dot ink` / `dot red` / `dot hl` | `dot gleam` (+ `plain` for stepper and role dots) / `dot ember` / `dot spark` |
| `sketch`, `.hover` hatch | removed; hover is `sheen` (handled inside `btn`, `navlist`, `tab`) |
| command bar input row | `input cmd-field` |

Rules to carry: `appearance: none` on every `<button>` that is a plate, btn, tab, chip or nav item (the UA button background paints outside the cut corner otherwise); the grain lives on `.plate::after`, never as a `background-image` on the plate; plates `overflow: clip`.

## 3. Layout

- The *New job or command* input moves from the status bar into the sidebar, under the repo line, full width with the `⌘K` hint inside. Below md it is the 44px button in the nav strip.
- The sidebar's title block is removed. Its facts (version, API, SESSIONS live dot + count, sheet) become the status bar's `.facts` strip between the left and right clusters; the bar is 36px.
- Inline counts read `Label (N)`: tabs, segment filters; right-aligned badges stay bare.

## 4. Icons

`lib/icons.ts` takes the geometry from `assets/Icons/*.svg` (1.5px, round caps and joins, no `cx` construction group any more: drop the `cx` arrays and the dashed rendering branch in `Icon.svelte`). `test/dashboard-icons.test.ts` compares against these files.

## 5. Tests and copy

- `test/dashboard-shell.test.ts` › "text never sits on the bare ground": the rule holds; `plate open` is the container class, `plain` the opaque strip.
- `messages/en.json`: `REV` → `YOU`; `DWG · …` → the view name; `Sheet S-01` goes; Settings › Grid and Paper → one Grain toggle; theme names Forge / Ash / System.
- Contrast was checked for every text/ground pair in both themes (see the usage notes in `tokens.json`); keep the pairs when porting.
