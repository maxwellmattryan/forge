# Drafting foundations: tokens, fonts, ground and utilities

Size: L · Needs design: yes (reference: `design/`) · Suggested reviewers: code, tests, ui, accessibility

## Goal
Put the Drafting design system's foundations under the dashboard so every later job only changes markup: tokens as CSS variables in two themes, the three vendored typefaces, the gridded paper ground, and the utility classes from `design/drafting.css`. The app keeps working on today's markup through aliases and already looks mostly drafted after this PR.

## Behaviour
- Two themes, `cyanotype` (default) and `vellum`, selected by `data-theme` on `<html>`. The saved `forge.theme` pref still works: `dark` reads as `cyanotype`, `light` as `vellum`; new saves write the new ids; `prefers-color-scheme: light` maps to `vellum`. The General settings tab shows the two names.
- The page ground is the sheet: `--bg` with the 8px/64px grid (`--grid-minor`, `--grid-major`), the paper fibre at `--paper-opacity`, and the exposure falloff on the main column. Dialogs, the drawer, toasts and the command bar sit on plain `--bg`.
- Type renders in Space Grotesk (headings), IBM Plex Sans (text) and IBM Plex Mono (everything technical), served from the dashboard itself; no request leaves the origin.
- Corners are square everywhere except dots and the `REV` tag; shadows are hard offsets.
- Existing components render through aliases of their old utility names (`card`, `chip`, `btn`, `btn-primary`, `nav-item`, `kpi*`, `tbl`, `prose-md`) mapped onto the new rules, so nothing breaks before jobs 3 and 4 move the markup.

## Acceptance criteria
- [ ] AC1 — `dashboard/style.css` declares every token in `design/tokens.json` as a CSS variable with the values of `design/tokens.css`, under `:root, [data-theme=cyanotype]` and `[data-theme=vellum]`; `design/tokens.css` and the built CSS agree on every `--` name and value · Proven by: a test that parses both and diffs the variables.
- [ ] AC2 — `forge.theme` values `dark`/`light` saved before this change open the matching new theme; new saves write `cyanotype`/`vellum` · Proven by: unit tests on `src/lib/theme.ts`.
- [ ] AC3 — The built dashboard makes no request outside its own origin: no `fonts.googleapis.com`, no `http(s)://` in `dist/` CSS or HTML · Proven by: a test over `dashboard/dist/**` plus a manual check of the network panel.
- [ ] AC4 — The three font families are served from `dist/assets/` and named in `dist/manifest.json` (or the server allowlist), with `OFL.txt` committed beside the sources · Proven by: a test that every `@font-face` `url()` in the built CSS resolves to a file the server serves; `curl` against `forge dash`.
- [ ] AC5 — Every utility in `design/drafting.css` exists as an `@utility` (or plain rule where it is never applied) of the same name in `style.css`, and the old names still apply · Proven by: `test/dashboard-css.test.ts` (new) checking the built CSS for each selector.
- [ ] AC6 — Text colours meet 4.5:1 on `--bg`, `--panel` and `--raised` in both themes, except `--dim` (placeholders) as documented · Proven by: a contrast test over the token values.
- [ ] AC7 — Both themes render at 1440px and 390px without horizontal scroll or clipped text on Pipeline, Needs you, the drawer and Settings · Proven by: ui lens screenshots `screenshots/ui-<view>-<theme>-<width>.png`.
- [ ] AC8 — `npm run build:dashboard` leaves `git status -- dashboard/dist` clean; `npm test`, `npm run check:dashboard`, the i18n and dist tests pass · Proven by: verify.

## Out of scope
New icons (job 2); moving component markup to the new classes (jobs 3–4); Grid/Paper preferences (job 5).

## Approach
- Rewrite `dashboard/style.css`: `@theme` maps `--color-*`/`--font-*` to the new variables; `:root`/`[data-theme=…]` blocks carry the token values; `@custom-variant dark` targets `[data-theme=cyanotype]`; `body` gets `ground`; add `@utility` blocks ported from `design/drafting.css` (`ground`, `falloff`, `hatch`, `hatch-dense`, `crosshatch`, `sheet`, `ticks`, `dashed`, `redline`, `solid`, `plain`, `btn` with `primary|sel|sm|icon|touch`, `seg`, `chip` tones incl. `live|rev|hl`, `nav`/`nav-item`, `input`, `check`, `radio`, `field`, `track`, `fill`, `tabs`, `tab`, `tbl`, `tblock`, `kpi`, `label`, `callout`, `dim-line`, `mono`, `num`, `prose`, `mark`, `dot`, `backdrop`); then the temporary aliases `card → sheet ticks` (ticks need an inner span, so the alias is `sheet` only), `btn-primary → btn primary`, `kpi-label → label`, `kpi-value → kpi .v`, `prose-md → prose`, `ember-bar → fill`, `brand-rule → dim-line`.
- Fonts: `dashboard/fonts/{SpaceGrotesk,IBMPlexSans,IBMPlexMono}-*.woff2` + `OFL.txt` (download from the Google Fonts GitHub repos at a pinned commit; Latin subsets; the weights in `design/tokens.json`); `@font-face` with `font-display: swap`; check `vite.config.mjs` emits them and `lib/server.ts` serves what the manifest lists under `assets` (extend the allowlist if it reads only `file` and `css`). `design/textures/paper.svg` becomes `dashboard/textures/paper.svg` referenced from `style.css`.
- `src/lib/theme.ts`: `Theme = 'cyanotype' | 'vellum'`, `normalizeTheme(saved | null, prefersLight)` used by `index.html`'s inline script (duplicated there, it runs before the bundle) and `currentTheme()`; `setTheme` writes the new id. `GeneralTab.svelte` labels from `en.json` (`settings.theme.cyanotype`, `settings.theme.vellum`).
- Tests: `test/dashboard-tokens.test.ts` (AC1, AC6), `test/dashboard-assets.test.ts` (AC3, AC4), `test/dashboard-css.test.ts` (AC5), theme unit tests (AC2).
- Docs: `README.md` › Dashboard mentions the two themes; `AGENTS.md` gains a line pointing at `design/` as the dashboard's design source of truth and the no-external-assets rule for fonts.

## Design references
`design/README.md` (Colour, Typography, Drawing conventions, States), `design/tokens.css`, `design/drafting.css`, `design/components/Button|Chip|Card|FormControls/preview.html` for the utilities.
