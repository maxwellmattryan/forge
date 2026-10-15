# Migrating the dashboard to the Drafting design system

This folder is the source of truth for the dashboard's look from here on. It was authored as a Forge design system (the "Forge" artifact in Claude) and exported verbatim: `README.md` is the brand book, `tokens.json` the tokens, `tokens.css` their compiled form, `drafting.css` the reference stylesheet every `components/*/preview.html` is rendered with, `icons/` the 23 line icons. Open any `components/<Name>/preview.html` in a browser; flip `data-theme` on `<html>` to `vellum` for the light theme or `nightprint` for the dark one. `components/index.html` links them all.

The code is the implementation; this folder is the drawing. When they disagree during migration, the drawing wins on visuals and the code wins on behaviour. Nothing here changes what the dashboard does: no new endpoints, no `/api` shape changes, no config keys.

## Hard constraints that shape the port

- **No external assets.** The dashboard loads nothing from the network (AGENTS.md), so the three typefaces are vendored, not linked: Space Grotesk, IBM Plex Sans and IBM Plex Mono are all SIL Open Font License; commit the `woff2` files (Latin subset, the weights in `tokens.json` `type.groups`: Grotesk 500/700, Plex Sans 400/500/600, Plex Mono 400/500/600) with their `OFL.txt`, declare them with `@font-face` in `dashboard/style.css`, and let Vite emit them into `dashboard/dist/assets/`. The server serves only what `dist/manifest.json` names: confirm CSS-referenced assets are listed (Vite's manifest `assets` field) and reachable through `lib/server.ts`'s allowlist, or extend the allowlist for them in the same change. The film grain is an inline SVG `data:` URI written in `style.css`: there is no texture file and no asset.
- **Tailwind v4 rules.** New classes are `@utility`s (so they can be `@apply`'d) or plain rules that are never `@apply`'d; class names in Svelte are whole literals. The reference `drafting.css` is plain CSS: port each rule block to an `@utility` of the same name (`sheet`, `ticks`, `hatch`, `btn`, `chip`, `nav-item`, …) and keep the token variables (`var(--line-strong)` and so on) rather than Tailwind colour utilities where a rule mixes several.
- **Themes are `data-theme` on `<html>`.** The theme ids are `cyanotype` (the default), `vellum` and `nightprint`, replacing `light`/`dark`. `index.html`'s inline script and `src/lib/theme.ts` must keep accepting the old saved values of the `forge.theme` pref (`dark` → `cyanotype`, `light` → `vellum`), and System (an explicit `system`, or an unset or unknown value) maps `prefers-color-scheme: light` to `vellum` and dark to `nightprint`. There is no `dark:` variant: theme differences live in the token blocks, and only vellum overrides a few rules (`a:hover`, `.backdrop`, `.scrim`, `.mark`).
- **Copy lives in `en.json`.** The new drafting words (`DWG`, `SHEET`, `REV`, `DRAWN BY`, `Cyanotype`, `Vellum`, `Nightprint`, `Grid`, `Paper`) are messages, never literals in markup.
- **Text never sits on the grid.** The grid and the grain show only on bare ground between surfaces. Every heading, label, chip, control, table, footnote, loading line and empty state renders on a `sheet` (not `sheet dashed`, which is transparent), `plain`, `solid` or `chrome` surface, or is itself a filled control (`btn`, `chip`, `input`). Page headers are `sheet ticks` title blocks, section headings are small heading sheets (an `h2` that is itself a `sheet`), and a dashed board column's header row and empty placeholder are `plain`. `test/dashboard-shell.test.ts` › "text never sits on the bare ground" enforces it.
- **Rebuild `dist/` in the same commit.** `npm run build:dashboard` after every change; the e2e/ui lens checks every theme at phone width.

## Token mapping (old `style.css` → `tokens.css`)

| Old variable | New | Note |
|---|---|---|
| `--bg` | `--bg` (+ `--bg-deep`) | same name, new values; the body also gets the `.ground` grid + grain |
| `--panel` | `--panel` | now a translucent wash; the 1px `--line` outline does the work |
| `--raised` | `--raised` | active/hover wash only; inputs are no longer filled |
| `--line` | `--line`, `--line-soft`, `--line-strong` | one line became three strengths |
| `--fg`, `--muted` | `--fg`, `--muted` (+ `--dim`) | `--dim` is placeholders only (fails 4.5:1 by design) |
| `--accent` | `--ink` | the one accent is now drawing ink; white on cyanotype, Prussian blue on vellum, pale blue on nightprint |
| `--on-accent` | `--on-ink` | |
| `--ember-hot` | — | removed with the gradients (`.ember-bar`, `.brand-rule`, `.btn-primary` background) |
| `--warn` as "needs you" | `--redline` | *needs a human* is markup red, not yellow; `--warn` stays for held/waiting/budget |
| `--ok`, `--warn`, `--bad`, `--info` | same names | new values; `--bad` equals `--redline` today but stays its own token |
| — | `--highlight` | marker yellow: unsaved dots, selection |
| — | `--grid-minor`, `--grid-major` | the ground's grid |
| Tailwind radii | `--radius-0`, `--radius-dot` | `rounded-*` utilities disappear from markup except `rounded-full` on dots |
| `shadow-lg`, `shadow-2xl` | `--shadow-dialog`, `--shadow-drawer`, `--shadow-primary` | hard offsets, no blur |
| `--font-sans`, `--font-mono` | `--font-sans`, `--font-mono`, `--font-head` | Inter → IBM Plex Sans; JetBrains Mono → IBM Plex Mono; Space Grotesk for headings |

Spacing keeps Tailwind's 4px scale; `tokens.json` lists the steps in use and adds `space-16` (64px) as the major grid. `size-*` tokens are the fixed widths (`w-56` sidebar → 236px, `w-72` column → 276px, `w-48` rail → 216px).

## Class and component mapping

| Today (`style.css` / Svelte) | Drafting (`drafting.css`) | Where it is drawn |
|---|---|---|
| `.card` (`bg-panel border border-line rounded-xl`) | `.sheet.ticks` with an inner `<span class="tk">` (a thing) · `.sheet.dashed` (a container) · `.sheet.redline` (needs a human) | `components/Card` |
| `.chip` + `TONE_CLASS` tints (`bg-ok/15 text-ok` …) | `.chip.<tone>`: outline in its own colour, no fill; new tones `live` (hatched ink), `rev` (rounded red), `hl` (yellow fill); `muted` is dashed | `components/Chip` |
| `.btn`, `.btn-primary` | `.btn`, `.btn.primary` (ink fill, `--shadow-primary`), `.btn.sel`, `.btn.sm`, `.btn.icon`, `.btn.ghost` (the close control), `.btn.touch`; groups in `.seg` | `components/Button`, `SegmentedControl` |
| `.nav-item`, `.nav-item.active` (inset 2px accent) | `.nav a`/`button`, `.active` = `--raised` + `--line-strong` border + 3px `--ink` left rule; hover hatches | `components/NavItem` |
| global `input, textarea, select` (raised fill, accent focus border) | `.input`: outline only, dashed-outline focus; `.check` / `.radio` drawn (`appearance: none`) | `components/FormControls` |
| `.kpi`, `.kpi-label`, `.kpi-value` | `.sheet.ticks.kpi` with `.label` and `.v` | `components/Kpi` |
| `.tbl` | `.tbl` inside a `.sheet.ticks`; rows `.clickable` | `components/Table` |
| `.prose-md` | `.prose` | `README.md` › Typography |
| `.ember-bar` (progress, usage bars) | `.track` > `.fill` (hatched ink, overshooting end tick); budget fills `.fill.ok|warn|bad` | `components/ProgressBar` |
| `.brand-rule`, sidebar footer | `.dim-line` (`DWG · PIPELINE`) and `.tblock` (DRAWN BY / SESSIONS / REV / API / SHEET) | `components/Sidebar` |
| `PageHeader` subtitle `<p>` | `.dim-line` under the `h1` | `components/PageHeader` |
| Drawer tab strip (`border-b-2 border-accent`) | `.tabs` > `.tab.active` (three drawn sides, `--bg` fill) | `components/Tabs`, `Drawer` |
| Board/table toggle, filter buttons | `.seg` of `.btn` (md, as page header controls are), selected `.sel` | `components/SegmentedControl` |
| `JobCard` `border-warn/50`, `InboxCard` `border-warn/40` | `.sheet.redline` + `.chip.rev` `REV · <state>` | `components/JobCard`, `InboxCard` |
| `Empty` (`card`, mark at 80%) | `.sheet.crosshatch` + `.mark` | `components/Empty` |
| `Banner` (`warn` tint) | `.sheet.redline` with a `REV` chip | `components/Banner` |
| `Toast` (`shadow-lg`) | `.sheet.ticks.solid` with `--shadow-dialog` | `components/Toast` |
| `Settings` rail (text only), `CommandBar`, `Drawer` | icons on every rail item; `SHEET S-01` label; `--shadow-dialog` / `--shadow-drawer`; footer `REV` chip | `components/SettingsDialog`, `CommandBar`, `Drawer` |
| `Icon.svelte` (1.8 stroke, round) + 13 paths | 1.25 stroke, round, plus a dashed `cx` construction segment; 23 names (settings tabs and controls added) | `components/Icon`, `icons/*.svg` |
| `img /forge.png` | `.mark` (one-colour print of the anvil, blend per theme) | `components/Sidebar`, `Empty` |

The `TONE_CLASS` map in `src/lib/util.ts` is the one place tones are named; `stateTone`/`verdictTone`/`prChipModel` in `src/lib/view.ts` decide which tone a state gets. The port adds `rev` and `live` to the map and routes `needsHuman(job)` states to `rev` and running states to `live`; nothing else in `view.ts` changes.

## Control sizing

Every control has one fixed height, from four tokens in `tokens.css` (`size` in `tokens.json`). Controls that sit side by side line up because they share a token, not because their padding happens to agree.

| Token | Value | Variants |
|---|---|---|
| `--control-xs` | 20px | `chip` and `button.chip`: inline annotations in tables, cards, log lines and inside buttons |
| `--control-sm` | 28px | `btn sm`, `btn sm icon`, `chip sm`, `input sm` / `select.sm`: dense toolbars |
| `--control-md` | 32px | `btn`, `btn primary`, `btn icon`, `input`, `select`, native text inputs; a textarea's minimum height |
| `--control-lg` | 40px | `tab` (the drawer's tab strip) |

- **A row holds one size**, with `gap-2` (8px, `--space-2`) between controls. A `seg` has no height of its own: its members are buttons of one size, and they still touch (the -1px overlap).
- **sm or md.** Use sm in dense toolbars and in drawer and sheet headers: the drawer header, the status bar and its popovers, the session log, permission prompts. Use md in page headers, forms and action rows: every view's header, `JobActions`, the action dock, settings.
- **Icon buttons are square** at their siblings' height: `btn icon` is 32×32, `btn sm icon` 28×28, with the 15px icon centred. A button with an icon and a label is as tall as one without.
- **Chips are xs annotations** unless they sit in a control row, where they take `chip sm` (the status bar's Daemon popover, the session pill, the palette's scope).
- **Phones (below 48rem) get a 44px floor:** every `button` but chips, `a.btn`, `select` and text input, sm ones included, is at least 44px tall, and icon buttons at least 44px wide. Native `input.sm` / `select.sm` sizing sits only inside a `min-width: 48rem` block, so it never beats the floor. Button chips keep their transparent 44px hit area; `btn touch` is unchanged.
- **One close control.** `CloseButton.svelte` renders `btn icon ghost` (plus `sm` beside sm siblings) holding the `close` icon. At rest its border is transparent, so only the cross shows; hover draws the sketch and a `--line` border, never heavier than a neighbouring `btn`'s `--line-strong`; it keeps the dashed focus ring and the ink press. The drawer, the Settings dialog, the command palette and the toast use it, and nothing else draws the close icon.

## Order of work

Five jobs, one pull request each, in dependency order. Each is written up in `jobs/` as a request Forge can take as-is; `jobs/EPIC.md` is the single request that asks the planner to split into these five.

1. **Foundations** — tokens, vendored fonts, the ground, the utility set, theme ids. The app keeps working on the old markup through aliases; it already looks mostly right after this PR.
2. **Iconography** — the 23 icons, `Icon.svelte`, icons on the settings rail.
3. **Shell** — sidebar, page header, segmented controls, tabs, settings dialog, command bar, drawer, banner, toast.
4. **Job surfaces** — cards, chips and tones, progress, board columns, empty states, daemon bar, thread, session log, KPIs and tables; remove the aliases.
5. **Appearance settings and polish** — theme names and Grid/Paper preferences in General, accessibility pass, README screenshots.

Every job verifies in every theme at desktop and phone width, rebuilds `dist/`, and keeps `npm test`, `npm run check:dashboard` and the i18n test green.
