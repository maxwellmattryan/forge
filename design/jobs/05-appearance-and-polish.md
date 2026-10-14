# Appearance settings and polish for the Drafting dashboard

Size: M · Needs design: yes · Suggested reviewers: code, tests, ui, accessibility, ux, docs

## Goal
Finish the Drafting migration: give people the two drawing preferences the design describes, make sure the whole dashboard passes an accessibility pass in both themes, and bring the docs' screenshots up to date.

## Behaviour
- General settings › Appearance: Theme (Cyanotype / Vellum / System) as a `seg`; **Grid** (draw the 8px grid on the ground) and **Paper** (fibre texture and exposure falloff) as drawn checkboxes. Both are browser preferences (`prefs.ts`, keys `forge.grid`, `forge.paper`, default on), applied as `data-grid`/`data-paper` attributes on `<html>` that `style.css` reads; they never touch `config.yml`.
- `prefers-reduced-motion` disables the drawer slide and the 120ms transitions.
- Density stays as it is unless a `dense` preference already exists; do not add one.
- `README.md` › Dashboard and `docs/` screenshots show the Drafting dashboard in cyanotype; the CHANGELOG gets an entry describing the new look, the theme ids and the two preferences.

## Acceptance criteria
- [ ] AC1 — Toggling Grid or Paper changes the ground immediately and survives reload; defaults are on; the attributes are set before first paint by the inline script in `index.html` · Proven by: unit tests on the pref helpers; ui lens screenshots `screenshots/ui-appearance-<state>.png`.
- [ ] AC2 — With `prefers-reduced-motion: reduce` no CSS transition or transform animation runs · Proven by: a test over the built CSS for the media query; manual check.
- [ ] AC3 — Every view, the drawer, settings and the command bar pass: contrast per the token notes, visible focus on every control, 44px targets on phones, `aria` unchanged from before the migration · Proven by: accessibility lens report in `review`, with screenshots.
- [ ] AC4 — `README.md` and `docs/` screenshots are regenerated; the CHANGELOG entry exists · Proven by: docs lens.
- [ ] AC5 — Build, typecheck, i18n and dist tests pass · Proven by: verify.

## Out of scope
New config keys; changing the daemon or settings-lock behaviour.

## Approach
`GeneralTab.svelte` (new rows, `en.json` keys `settings.grid`, `settings.paper` and their hints), `src/lib/prefs.ts` (typed keys), `index.html` inline script (apply `data-grid`/`data-paper` with the theme), `style.css` (`html[data-grid=off] .ground { background-image: none }`, `html[data-paper=off] .ground::before, .ground::after { display: none }`, the reduced-motion block), `README.md`, `docs/`, `CHANGELOG.md`.

## Design references
`design/components/SettingsDialog/preview.html`, `design/README.md` › States.
