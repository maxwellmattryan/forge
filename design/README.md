Forge is a software factory for AI coding agents: you hand it a feature, a bug or a backlog item; a team of agents plans, specs, builds, reviews and opens a pull request, or stops and asks you. The dashboard is the engineering drawing of that factory: a cyanotype sheet (or vellum, in the light theme) ruled with a grid, everything on it drawn in one-pixel line, hatched where it needs weight, and marked in red where a person has to look. Nothing is rounded, nothing is blurred, nothing is filled that an outline could say.

## Voice and content

- Write in plain, short sentences. Buttons are a verb, rarely two words: "Run next", "Approve", "Accept split", "Start", "Stop", "Follow", "Load older".
- Address the person as *you* and the system as *Forge* ("Forge v0.9.0" in the title block, "Forge · {repo}" in the window title). Agents are named by role in lowercase mono: `planner`, `builder`, `reviewer`.
- Sentence case for prose and titles. Uppercase belongs to the technical styles only: `nav`, `control`, `label` and `dim` are set in IBM Plex Mono with tracking, as a draughtsman letters a drawing. Never uppercase a heading or body copy.
- Numbers, ids, refs, branches, verbs and paths are always mono (`mono`, `mono-log`): `job-7f3a`, `#142`, `LIN-88`, `forge/job-7f3a`, `/forge continue`.
- Drafting vocabulary is used sparingly and literally: `REV` marks what a human must revise or approve; `DWG`, `SHEET` and the title block name the page; a dimension line carries a measurement-like fact (`3 ACTIVE · BASE MAIN · GITHUB`). Do not invent more.
- Em-dash `—` is the empty value in tables and fact grids; a crosshatched sheet is the empty state. Counts sit after their label: "Active 3".
- No emoji anywhere. Status is a word in a chip, never a glyph alone. Untrusted text (session output, tracker titles, request notes) renders as plain text, or as markdown only through the escape-first `md()` with a Raw view one click away.

## Colour

Two themes, the same drawing. Cyanotype is the primary: white line on a Prussian-blue wash. Vellum is the light theme: Prussian-blue ink on warm paper. Design in both; every pair below is named in the tokens' usage notes.

- The ground is `bg` with the grid (`grid-minor` every 8px, `grid-major` every 64px), the paper fibre over it and `bg-deep` shading the corners. Dialogs, the drawer, toasts and the command bar sit on plain `bg` (`.solid`, `.plain`) so type on them stays crisp.
- A sheet is `panel` (near transparent) inside a 1px `line` outline; `raised` is the wash of an active or hovered item. Fills are translucent so they sit on the grid; text and ink are opaque.
- Three line weights of colour, one physical weight: `line` for everything drawn, `line-soft` for hatching and construction, `line-strong` for register ticks, the active rule, focused borders and dimension ends. Nothing is thicker than 1px except the 3px `ink` marker on the active nav item.
- Text is `fg` or `muted`; `dim` is for placeholders and the title block's keys only (it does not meet 4.5:1 and is never used for copy a person must read).
- `ink` is full-strength drawing ink: the primary button, the selected segment, the progress fill, the active rule, the live-agent dot. `on-ink` is the text on it. There is no second accent.
- `redline` is markup red and means *you*: `REV` tags, the dashed red outline of a job waiting on a person, banners, the settings-tab error dot. `highlight` is marker yellow and means *changed*: unsaved dots, held and waiting counts, `::selection`; on vellum it is only ever a fill under dark text.
- Status hues each carry one meaning and always a word: `ok` success, `warn` attention, `bad` failure, `info` neutral kind. Chips are the hue as text in its own outline, never a tint fill; `ok` and `bad` differ in lightness as well as hue in both themes.
- Contrast: every text colour clears 4.5:1 on `bg`, `panel` and `raised` in both themes (the weakest are `redline`/`bad` at 4.6:1 on cyanotype `raised` and `ok` at 4.65:1 on vellum `raised`; `warn` there is 4.7:1); `dim` is the stated exception. The sidebar's darkened ground is black at 8% on cyanotype and 5% on vellum, which keeps `muted` at 4.79:1 there, and hovered links turn `fg` on vellum, because `highlight` is only ever a fill there. Lines are decorative and never the sole carrier of meaning: the thing a line encloses always has a word or a chip.

## Typography

Three families, all Google-hosted (no files): Space Grotesk for headings, IBM Plex Sans for reading, IBM Plex Mono for everything technical.

- Headings are Space Grotesk 700 with -0.01em tracking: `page-title` (34) for a view, `sheet-title` (22) for the drawer and dialogs, `section-title` (16) inside sheets, `display` (64) only for the system itself. `card-title` (14, 500) titles job cards and table rows and is the one heading weight below bold.
- Body is Plex Sans 400 at `body` (14/20); rendered markdown uses `body-prose` (14/24) with the heading styles above and `mono` code on a `raised` ground. `caption` (12) carries timelines and footnotes.
- The technical layer is Plex Mono, uppercase and tracked: `nav` (13, .06em) for nav and rail items and tabs, `control` (12, .08em) for buttons and chips, `label` (11, .12em, `muted`) for callouts, headers and footers, `dim` (10, .08em) inside dimension lines and the title block. `mono` (12) and `mono-log` (11) are the only lowercase mono styles. `kpi-value` (24, 500, tabular) is the one large number.
- Hierarchy comes from the switch between families before it comes from size: a Grotesk title over a mono label over Plex Sans copy is the standard stack of every sheet.
- Numbers that line up are `tabular-nums`. Long titles clamp to two lines; mono facts `break-all`.

## Drawing conventions

- Sheets (`.sheet.ticks`) are outlines with 9px `tick` marks at the corners: the standard card, KPI tile, table wrapper, thread message, dialog. A dashed outline without ticks (`.dashed`) is a container: board columns, the ⌘K button at the end of each page header, a focus ring. A `redline` sheet (red outline plus a dashed red outline 3px outside it) is a thing waiting on a person.
- Hatching replaces tints: `hatch` (1px `line-soft` at 45° every `hatch-pitch` 6px) for hover and the live chip, `hatch-dense` (4px) for progress fills, `crosshatch` for disabled regions and empty states.
- Dimension lines (`.dim-line`: a hairline with 10px end ticks and a `dim` label) replace subtitles under page titles and name the drawing in the sidebar. Callouts (`.callout`: an 18px leader line before a `label`) head every section inside a sheet or dialog.
- The title block (`.tblock`) at the sidebar's foot carries what a footer would: DRAWN BY, SESSIONS, REV (the version), API, SHEET (the view and its number).
- Icons are 1.25px round-capped line drawings at `size-icon` (18px) with a dashed construction mark each; see `assets/Icons/README.md`. The mark is a one-colour print of the anvil (`.mark`).

## Spacing and layout

- An 8px grid with a 64px major. `space-2` is the resting gap inside a sheet; `space-3` the padding of a dense card and the horizontal inset of buttons and cells; `space-4` the padding of a standard sheet; columns and the sidebar are multiples of `space-16`.
- The shell is a `size-sidebar` (236px) column on a slightly darkened ground with a `line` right edge, then a main column capped at `size-content-max` with `space-4` gutters on phones and `space-8` at md and up. Below md the sidebar becomes a horizontal strip of nav items with a 44px (`space-11`) settings target, and the command palette opens from a 56px square primary button fixed at the bottom right (the FAB), above the safe area; the view and the toast keep clear of it.
- The pipeline board is four dashed group columns (Queued, Plan, Build, Ship) in a grid of 1 column below `lg`, 2 at `lg` and 4 at `xl`, so it never scrolls sideways; at `xl` each column scrolls inside itself. Done and cancelled jobs sit in a full-width Done section below the grid when the filter holds any. The table layout is a ticked sheet around `.tbl`.
- The drawer slides in from the right at `size-drawer-max` with `shadow-drawer` (a stacked sheet to its left); the settings dialog (`size-dialog`) and the command bar (672px) are centred solid sheets with `shadow-dialog`, full-width sheets below md. Settings and the drawer sit over `backdrop`; the command bar sits over the lighter `scrim` (about a third as dark), so the page or drawer it was opened from stays readable.

## Radii, borders and shadows

- `radius-0` everywhere; dots are circles (`radius-dot`).
- Every border is 1px. Hover never thickens a line; it strengthens its colour (`line` → `line-strong`) or hatches the face.
- Shadows are hard offsets, never blur: `shadow-primary` (3px) under the primary button, `shadow-dialog` (8px) behind dialogs, `shadow-drawer` (-8px) beside the drawer. Each reads as a second sheet behind the first.

## States

- Hover: hatch the face (buttons, nav items, tabs) or strengthen the outline and wash with `raised` (sheets, rows). A primary button lifts 1px and its shadow grows to 4px `line`.
- Focus: a 1px dashed `line-strong` outline at 2–3px (`dash`), on every control; checkboxes and radios too. Never a glow.
- Pressed or selected: solid `ink` with `on-ink` text (buttons, segments); a primary button drops onto its shadow. The active nav item or tab takes `raised`, a `line-strong` border and the 3px `ink` rule.
- Disabled: 40% opacity and a dashed border; a disabled primary button loses its fill and shadow.
- Live: the `live` chip (ink over hatching), an `ink` dot before the agent's role, and the live dot for an active daemon session: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. Idle and waiting sessions are a hollow dot; a session waiting on a permission is the `warn` chip *needs permission*. Needs you: `redline`. Changed: `highlight` (a card's `dot hl` for 3 s after a poll changes it, a drawer row that arrived since it opened, the Thread tab's `chip hl` unread count).

## Motion

Motion is limited to 120ms colour and transform transitions, the drawer's slide, and the live dot: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. The paper and grid never move. Reduced motion turns off every transition and animation, including the drawer's slide and the halo.

## Iconography and imagery

Twenty-three line icons as described above and in `assets/Icons/README.md`; the paper fibre in `assets/Textures/`; the anvil in `assets/Logos/`. Nothing else is illustrated: no photographs, no gradients, no decorative shapes beyond the grid, the hatch and the register marks.
