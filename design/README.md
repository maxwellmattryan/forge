Forge is a software factory for AI coding agents: you hand it a feature, a bug or a backlog item; a team of agents plans, specs, builds, reviews and opens a pull request, or stops and asks you. The dashboard is the engineering drawing of that factory: a cyanotype sheet (or vellum, in the light theme) ruled with a grid, everything on it drawn in one-pixel line on opaque sheets that stand off the ground, and marked in red where a person has to look. Nothing is rounded, nothing is blurred, nothing is filled that an outline could say.

## Voice and content

- Write in plain, short sentences. Buttons are a verb, rarely two words: "Run next", "Approve", "Accept split", "Start", "Stop", "Follow", "Load older".
- Address the person as *you* and the system as *Forge* ("Forge v0.9.0" in the title block, "Forge · {repo}" in the window title). Agents are named by role in lowercase mono: `planner`, `builder`, `reviewer`.
- Sentence case for prose and titles. Uppercase belongs to the technical styles only: `nav`, `control`, `label` and `dim` are set in IBM Plex Mono with tracking, as a draughtsman letters a drawing. Never uppercase a heading or body copy.
- Numbers, ids, refs, branches, verbs and paths are always mono (`mono`, `mono-log`): `job-7f3a`, `#142`, `LIN-88`, `forge/job-7f3a`, `/forge continue`.
- Drafting vocabulary is used sparingly and literally: `REV` marks what a human must revise or approve; `DWG`, `SHEET` and the title block name the page; a dimension line carries a measurement-like fact (`3 ACTIVE · BASE MAIN · GITHUB`). Do not invent more.
- Em-dash `—` is the empty value in tables and fact grids; a sheet with a dashed outline is the empty state. Counts sit after their label: "Active 3".
- No emoji anywhere. Status is a word in a chip, never a glyph alone. Untrusted text (session output, tracker titles, request notes) renders as plain text, or as markdown only through the escape-first `md()` with a Raw view one click away.

## Colour

Two themes, the same drawing. Cyanotype is the primary: white line on a Prussian-blue wash. Vellum is the light theme: Prussian-blue ink on warm paper. Design in both; every pair below is named in the tokens' usage notes.

- The ground is `bg` with the grid (`grid-minor` every 8px, `grid-major` every 64px), the paper fibre over it and `bg-deep` shading the corners. Only the ground carries the grid and the paper: Settings › Grid and Paper change the ground and nothing else.
- Three levels step away from the ground toward the theme's highest-contrast colour. Sheets and overlays (cards, KPI tiles, table wrappers, the drawer, dialogs, the command bar, toasts) fill with opaque `panel` inside a 1px `line` outline: darker than the ground on cyanotype, lighter on vellum. The sidebar and the phone header are opaque `chrome`, the furthest step, with a `line-strong` edge. `fg` climbs 9.41 → 11.04 → 13.14:1 on cyanotype and 10.45 → 11.62 → 12.12:1 on vellum. Dashed board columns stay transparent containers drawn on the ground; the cards in them are opaque.
- Every fill is opaque. A filled element (a chip, a button, a nav item, a tab, a field, a progress track) takes the colour of the surface it sits on (`panel` in sheets and overlays, `chrome` in the sidebar, `bg` on the ground) and its border carries the affordance, so no fill ever shows a pattern through it. `raised` is the one translucent wash (the active nav item, hovered table rows, the command bar's active option), always over a plain opaque fill.
- Three line weights of colour, one physical weight: `line` for everything drawn, `line-soft` for construction and soft rules, `line-strong` for register ticks, the active rule, focused borders and dimension ends. Nothing is thicker than 1px except the 3px `ink` marker on the active nav item.
- Text is `fg` or `muted`; `dim` is for placeholders and the title block's keys only (it does not meet 4.5:1 and is never used for copy a person must read).
- `ink` is full-strength drawing ink: the primary button, the selected segment, the progress fill, the active rule, the live-agent dot. `on-ink` is the text on it. There is no second accent.
- `redline` is markup red and means *you*: `REV` tags, the dashed red outline of a job waiting on a person, banners, the settings-tab error dot. `highlight` is marker yellow and means *changed*: unsaved dots, held and waiting counts, `::selection`; on vellum it is only ever a fill under dark text.
- Status hues each carry one meaning and always a word: `ok` success, `warn` attention, `bad` failure, `info` neutral kind. Chips are the hue as text in its own outline on their surface's fill, never a tint (the `live` chip's 12% ink is the one, and means working now); `ok` and `bad` differ in lightness as well as hue in both themes.
- Contrast: every text colour clears 4.5:1 on `bg`, `panel` and `chrome`, and on `panel` and `chrome` under `raised` or the hover sketch, in both themes; `dim` is the stated exception. The weakest pairs are `panel` under the sketch (`redline`/`bad` 4.78:1 on cyanotype, `ok` 4.67:1 on vellum), `chrome` under the sketch (5.63 / 4.86:1) and `panel` under `raised` (5.37 / 5.15:1). `muted` falls to about 4.2:1 on the ground under the sketch, so a hovered button's `muted` text takes its `fg`. Hovered links turn `fg` on vellum, because `highlight` is only ever a fill there. Lines are decorative and never the sole carrier of meaning: the thing a line encloses always has a word or a chip.

## Typography

Three families, all Google-hosted (no files): Space Grotesk for headings, IBM Plex Sans for reading, IBM Plex Mono for everything technical.

- Headings are Space Grotesk 700 with -0.01em tracking: `page-title` (34) for a view, `sheet-title` (22) for the drawer and dialogs, `section-title` (16) inside sheets, `display` (64) only for the system itself. `card-title` (14, 500) titles job cards and table rows and is the one heading weight below bold.
- Body is Plex Sans 400 at `body` (14/20); rendered markdown uses `body-prose` (14/24) with the heading styles above and `mono` code on a `raised` ground. `caption` (12) carries timelines and footnotes.
- The technical layer is Plex Mono, uppercase and tracked: `nav` (13, .06em) for nav and rail items and tabs, `control` (12, .08em) for buttons and chips, `label` (11, .12em, `muted`) for callouts, headers and footers, `dim` (10, .08em) inside dimension lines and the title block. `mono` (12) and `mono-log` (11) are the only lowercase mono styles. `kpi-value` (24, 500, tabular) is the one large number.
- Hierarchy comes from the switch between families before it comes from size: a Grotesk title over a mono label over Plex Sans copy is the standard stack of every sheet.
- Numbers that line up are `tabular-nums`. Long titles clamp to two lines; mono facts `break-all`.

## Drawing conventions

- Sheets (`.sheet.ticks`) are outlines with 9px `tick` marks at the corners: the standard card, KPI tile, table wrapper, thread message, dialog. A dashed outline without ticks (`.dashed`) is a container: board columns, the ⌘K button at the end of each page header, a focus ring. A `redline` sheet (red outline plus a dashed red outline 3px outside it) is a thing waiting on a person.
- The sketch marks hover: a hovered card, button, nav item, tab or button chip draws 1px `sketch-line` lines at 45° every `hatch-pitch` (6px) over its own opaque fill. Only three patterns exist, each on one element: the grid on the ground, the paper fibre on the ground's layer, the sketch on the hovered control. A patterned element never holds another, and nothing with a fill of its own sits on a pattern.
- Dimension lines (`.dim-line`: a hairline with 10px end ticks and a `dim` label) replace subtitles under page titles and name the drawing in the sidebar. Callouts (`.callout`: an 18px leader line before a `label`) head every section inside a sheet or dialog.
- The title block (`.tblock`) at the sidebar's foot carries what a footer would: DRAWN BY, SESSIONS, REV (the version), API, SHEET (the view and its number).
- Icons are 1.25px round-capped line drawings at `size-icon` (18px) with a dashed construction mark each; see `assets/Icons/README.md`. The mark is a one-colour print of the anvil (`.mark`).

## Spacing and layout

- An 8px grid with a 64px major. `space-2` is the resting gap inside a sheet; `space-3` the padding of a dense card and the horizontal inset of buttons and cells; `space-4` the padding of a standard sheet; columns and the sidebar are multiples of `space-16`.
- The shell is a `size-sidebar` (236px) column of opaque `chrome` with a `line-strong` right edge and a hard 8px `shadow-chrome` painted over the main column (the sidebar sits at z-10, under the drawer and dialogs), then a main column capped at `size-content-max` with `space-4` gutters on phones and `space-8` at md and up. Below md the sidebar becomes a horizontal strip of nav items with a 44px (`space-11`) settings target, and the command palette opens from a 56px square primary button fixed at the bottom right (the FAB), above the safe area; the view and the toast keep clear of it.
- The pipeline board is four dashed group columns (Queued, Plan, Build, Ship) in a grid of 1 column below `lg`, 2 at `lg` and 4 at `xl`, so it never scrolls sideways; at `xl` each column scrolls inside itself. Done and cancelled jobs sit in a full-width Done section below the grid when the filter holds any. The table layout is a ticked sheet around `.tbl`.
- The drawer slides in from the right at `size-drawer-max` with `shadow-drawer` (a stacked sheet to its left); the settings dialog (`size-dialog`) and the command bar (672px) are centred solid sheets with `shadow-dialog`, full-width sheets below md. Settings and the drawer sit over `backdrop`; the command bar sits over the lighter `scrim` (about a third as dark), so the page or drawer it was opened from stays readable.

## Radii, borders and shadows

- `radius-0` everywhere; dots are circles (`radius-dot`).
- Every border is 1px. Hover never thickens a line; it strengthens its colour (`line` → `line-strong`) or sketches the face.
- Shadows are hard offsets, never blur: `shadow-primary` (3px) under the primary button, `shadow-dialog` (8px) behind dialogs, `shadow-drawer` (-8px) beside the drawer, `shadow-chrome` (8px) right of the sidebar. Each reads as a second sheet behind the first.

## States

- Hover: sketch the face (cards, buttons, nav items, tabs, button chips): the lines fade in and slide 6px into place, and a card's outline strengthens while its fill stays `panel`. Table rows wash with `raised` instead. The sketch only turns on where the pointer can hover, so a tap on a touch screen leaves no lines, and it is never inherited: a hovered card's chips stay plain. Selected segments, primary, pressed and disabled buttons, the active nav item and the active tab never sketch. A primary button lifts 1px and its shadow grows to 4px `line`.
- Focus: a 1px dashed `line-strong` outline at 2–3px (`dash`), on every control; checkboxes and radios too. Never a glow.
- Pressed or selected: solid `ink` with `on-ink` text (buttons, segments); a primary button drops onto its shadow. The active nav item takes `raised`, a `line-strong` border and the 3px `ink` rule; the active tab fills with `panel` and draws its three sides in `line`.
- Disabled: 40% opacity and a dashed border; a disabled primary button takes its surface's fill and loses its shadow.
- Live: the `live` chip (ink text on an opaque 12% ink tint of its surface), an `ink` dot before the agent's role, and the live dot for an active daemon session: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. Idle and waiting sessions are a hollow dot; a session waiting on a permission is the `warn` chip *needs permission*. Needs you: `redline`. Changed: `highlight` (a card's `dot hl` for 3 s after a poll changes it, a drawer row that arrived since it opened, the Thread tab's `chip hl` unread count).

## Motion

Motion is limited to 120ms colour and transform transitions, the 160 ms sketch (`ease-out`), the drawer's slide, and the live dot: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. The paper and grid never move. Reduced motion turns off every transition and animation: the sketch appears and disappears at once, and the drawer doesn't slide or show the halo.

## Iconography and imagery

Twenty-three line icons as described above and in `assets/Icons/README.md`; the paper fibre in `assets/Textures/`; the anvil in `assets/Logos/`. Nothing else is illustrated: no photographs, no gradients, no decorative shapes beyond the grid, the hover sketch and the register marks.
