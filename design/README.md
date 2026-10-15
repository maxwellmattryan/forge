Forge is a software factory for AI coding agents: you hand it a feature, a bug or a backlog item; a team of agents plans, specs, builds, reviews and opens a pull request, or stops and asks you. The dashboard is the engineering drawing of that factory: a cyanotype sheet (or vellum, in the light theme, or nightprint, in the dark one) ruled with a grid, everything on it drawn in one-pixel line on opaque sheets that stand off the ground, and marked in red where a person has to look. Nothing is rounded, nothing is blurred, nothing is filled that an outline could say.

## Voice and content

- Write in plain, short sentences. Buttons are a verb, rarely two words: "Run next", "Approve", "Accept split", "Start", "Stop", "Follow", "Load older".
- Address the person as *you* and the system as *Forge* ("Forge v0.9.0" in the title block, "Forge · {repo}" in the window title). Agents are named by role in lowercase mono: `planner`, `builder`, `reviewer`.
- Sentence case for prose and titles. Uppercase belongs to the technical styles only: `nav`, `control`, `label` and `dim` are set in IBM Plex Mono with tracking, as a draughtsman letters a drawing. Never uppercase a heading or body copy.
- Numbers, ids, refs, branches, verbs and paths are always mono (`mono`, `mono-log`): `job-7f3a`, `#142`, `LIN-88`, `forge/job-7f3a`, `/forge continue`.
- Drafting vocabulary is used sparingly and literally: `REV` marks what a human must revise or approve; `DWG`, `SHEET` and the title block name the page; a dimension line carries a measurement-like fact (`3 ACTIVE · BASE MAIN · GITHUB`). Do not invent more.
- Em-dash `—` is the empty value in tables and fact grids; a sheet with a dashed outline is the empty state. Counts sit after their label: "Active 3".
- No emoji anywhere. Status is a word in a chip, never a glyph alone. Untrusted text (session output, tracker titles, request notes) renders as plain text, or as markdown only through the escape-first `md()` with a Raw view one click away.

## Colour

Three themes, the same drawing. Cyanotype is the primary: white line on a bright Prussian-blue wash, a true blueprint. Vellum is the light theme: Prussian-blue ink on near-white paper. Nightprint is the dark theme: pale blue line on a blue-black ground, a blueprint at night. Settings › System shows vellum on a light OS and nightprint on a dark one. Design in all three; every pair below is named in the tokens' usage notes.

- The ground is `bg` with the grid (`grid-minor` every 8px, `grid-major` every 64px), the paper fibre over it and `bg-deep` shading the corners. Only the ground carries the grid and the paper: Settings › Grid and Paper change the ground and nothing else.
- Three levels step away from the ground toward the theme's highest-contrast colour. Sheets and overlays (cards, KPI tiles, table wrappers, the drawer, dialogs, the command bar, toasts) fill with opaque `panel` inside a 1px `line` outline: darker than the ground on cyanotype and nightprint, lighter on vellum. The sidebar and the phone header are opaque `chrome`, the furthest step, with a `line-strong` edge. `fg` climbs 10.17 → 12.01 → 13.97:1 on cyanotype, 10.72 → 12.01 → 12.32:1 on vellum and 13.01 → 14.73 → 15.55:1 on nightprint, and a sheet stands at least 1.12:1 off the ground. Dashed board columns stay transparent containers drawn on the ground; the cards in them are opaque.
- Every fill is opaque. A filled element (a chip, a button, a nav item, a tab, a field, a progress track) takes the colour of the surface it sits on (`panel` in sheets and overlays, `chrome` in the sidebar, `bg` on the ground) and its border carries the affordance, so no fill ever shows a pattern through it. `raised` is the one translucent wash (the active nav item, hovered table rows, the command bar's active option), always over a plain opaque fill.
- Three line weights of colour, one physical weight: `line` for everything drawn, `line-soft` for construction and soft rules, `line-strong` for register ticks, the active rule, focused borders and dimension ends. Nothing is thicker than 1px except the 3px `ink` marker on the active nav item.
- Text is `fg` or `muted`; `dim` is for placeholders and the title block's keys only (it does not meet 4.5:1 and is never used for copy a person must read).
- `ink` is full-strength drawing ink: the primary button, the selected segment, the progress fill, the active rule, the live-agent dot. `on-ink` is the text on it. There is no second accent.
- `redline` is markup red and means *you*: `REV` tags, the dashed red outline of a job waiting on a person, banners, the settings-tab error dot. `highlight` is marker yellow and means *changed*: unsaved dots, held and waiting counts, `::selection`, a hovered link on the two dark themes; on vellum it is only ever a fill under dark text.
- Status hues each carry one meaning and always a word: `ok` success, `warn` attention, `bad` failure, `info` neutral kind. Chips are the hue as text in its own outline on their surface's fill, never a tint (the `live` chip's 12% ink is the one, and means working now); `ok` and `bad` differ in lightness as well as hue in every theme.
- Contrast: every text colour clears 4.5:1 on `bg`, `panel` and `chrome`, and on `panel` and `chrome` under `raised` or the hover sketch, in all three themes; `dim` is the stated exception (4.15:1 on cyanotype, 2.58:1 on vellum, 3.44:1 on nightprint). The weakest pairs (cyanotype / vellum / nightprint) are `panel` under the sketch (`redline`/`bad` 5.21:1, `ok` 4.82:1, `muted` 6.04:1), the ground under `raised` (5.01 / 4.77 / 5.86:1), `chrome` under the sketch (5.98 / 4.94 / 6.54:1) and `panel` under `raised` (5.85 / 5.32 / 6.78:1). `muted` on the ground under the sketch is 4.90 / 4.41 / 5.20:1, below 4.5 on vellum, so a hovered button's `muted` text takes its `fg`. The dashed focus ring (`line-strong`) is at least 3:1 on every surface (10.17 / 7.23 / 11.55:1 on the ground). Hovered links turn `fg` on vellum, because `highlight` is only ever a fill there. Lines are decorative and never the sole carrier of meaning: the thing a line encloses always has a word or a chip.

## Typography

Three families, all Google-hosted (no files): Space Grotesk for headings, IBM Plex Sans for reading, IBM Plex Mono for everything technical.

- Headings are Space Grotesk 700 with -0.01em tracking: `page-title` (34) for a view, `sheet-title` (22) for the drawer and dialogs, `section-title` (16) inside sheets, `display` (64) only for the system itself. `card-title` (14, 500) titles job cards and table rows and is the one heading weight below bold.
- Body is Plex Sans 400 at `body` (14/20); rendered markdown uses `body-prose` (14/24) with the heading styles above and `mono` code on a `raised` ground. `caption` (12) carries timelines and footnotes.
- The technical layer is Plex Mono, uppercase and tracked: `nav` (13, .06em) for nav and rail items and tabs, `control` (12, .08em) for buttons and chips, `label` (11, .12em, `muted`) for callouts, headers and footers, `dim` (10, .08em) inside dimension lines and the title block. `mono` (12) and `mono-log` (11) are the only lowercase mono styles. `kpi-value` (24, 500, tabular) is the one large number.
- Hierarchy comes from the switch between families before it comes from size: a Grotesk title over a mono label over Plex Sans copy is the standard stack of every sheet.
- Numbers that line up are `tabular-nums`. Long titles clamp to two lines; mono facts `break-all`.

## Drawing conventions

- Sheets (`.sheet.ticks`) are outlines with 9px `tick` marks at the corners: the standard card, KPI tile, table wrapper, thread message, dialog. A dashed outline without ticks (`.dashed`) is a container: board columns, a focus ring. A `redline` sheet (red outline plus a dashed red outline 3px outside it) is a thing waiting on a person.
- The sketch marks hover: a hovered button, nav item, tab or button chip draws 1px `sketch-line` lines at 45° every `hatch-pitch` (6px) over its own opaque fill. A hovered card only strengthens its outline. Only three patterns exist, each on one element: the grid on the ground, the paper fibre on the ground's layer, the sketch on the hovered control. A patterned element never holds another, and nothing with a fill of its own sits on a pattern.
- Dimension lines (`.dim-line`: a hairline with 10px end ticks and a `dim` label) replace subtitles under page titles and name the drawing in the sidebar. Callouts (`.callout`: an 18px leader line before a `label`) head every section inside a sheet or dialog.
- The title block (`.tblock`) at the sidebar's foot carries what a footer would: DRAWN BY, SESSIONS, REV (the version), API, SHEET (the view and its number).
- Icons are 1.25px round-capped line drawings at `size-icon` (18px) with a dashed construction mark each; see `assets/Icons/README.md`. The mark is a one-colour print of the anvil (`.mark`).

## Spacing and layout

- An 8px grid with a 64px major. `space-2` is the resting gap inside a sheet; `space-3` the padding of a dense card and the horizontal inset of buttons and cells; `space-4` the padding of a standard sheet; columns and the sidebar are multiples of `space-16`.
- The shell is a `size-sidebar` (236px) column of opaque `chrome` with a `line-strong` right edge and a hard 8px `shadow-chrome` painted over the main column (the sidebar sits at z-10, under the drawer and dialogs), then a main column capped at `size-content-max` with `space-4` gutters on phones and `space-8` at md and up. Below md the sidebar becomes a horizontal strip of nav items with a 44px (`space-11`) settings target. The status bar is one opaque `chrome` row fixed at the bottom of every view, `size-statusbar` (48px) tall plus the safe-area inset, with a `line-strong` top edge: full width below md, the content column only at md and up (the sidebar keeps its full height). It holds the daemon and inbox indicators, the *New job or command* input (a full-width button below md) and the model and connection indicators; each indicator opens a `sheet ticks solid` popover `space-2` above the bar. The view, the toast and (md and up) the drawer clear it. The z-order, from the back: sidebar z-10, drawer backdrop z-30, status bar z-35, drawer z-40, popovers z-42, Settings and the palette z-45, toast z-50.
- The pipeline board is four dashed group columns (Queued, Plan, Build, Ship) in a grid of 1 column below `lg`, 2 at `lg` and 4 at `xl`, so it never scrolls sideways; at `xl` each column scrolls inside itself. Done and cancelled jobs sit in a full-width Done section below the grid when the filter holds any. The table layout is a ticked sheet around `.tbl`.
- The drawer slides in from the right at `size-drawer-max` with `shadow-drawer` (a stacked sheet to its left); the settings dialog (`size-dialog`) and the command bar (672px) are centred solid sheets with `shadow-dialog`, full-width sheets below md. Settings and the drawer sit over `backdrop`; the command bar sits over the lighter `scrim` (about a third as dark), so the page or drawer it was opened from stays readable.

## Radii, borders and shadows

- `radius-0` everywhere; dots are circles (`radius-dot`).
- Every border is 1px. Hover never thickens a line; it strengthens its colour (`line` → `line-strong`) or sketches the face.
- Shadows are hard offsets, never blur: `shadow-primary` (3px) under the primary button, `shadow-dialog` (8px) behind dialogs, `shadow-drawer` (-8px) beside the drawer, `shadow-chrome` (8px) right of the sidebar. Each reads as a second sheet behind the first.

## States

- Hover: sketch the face of buttons, nav items, tabs and button chips: the lines fade in and slide 6px into place. A card's outline turns `line-strong` at once while its fill stays `panel`, with no sketch and no transition. Table rows wash with `raised`, also at once. The sketch only turns on where the pointer can hover, so a tap on a touch screen leaves no lines, and it is never inherited: a chip inside a hovered control stays plain. Selected segments, primary, pressed and disabled buttons, the active nav item and the active tab never sketch. A primary button lifts 1px and its shadow grows to 4px `line`.
- Focus: a 1px dashed `line-strong` outline at 2–3px (`dash`), on every control; checkboxes and radios too. Never a glow.
- Pressed or selected: solid `ink` with `on-ink` text (buttons, segments); a primary button drops onto its shadow. The active nav item takes `raised`, a `line-strong` border and the 3px `ink` rule; the active tab fills with `panel` and draws its three sides in `line`.
- Disabled: 40% opacity and a dashed border; a disabled primary button takes its surface's fill and loses its shadow.
- Live: the `live` chip (ink text on an opaque 12% ink tint of its surface), an `ink` dot before the agent's role, and the live dot for an active daemon session: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. Idle and waiting sessions are a hollow dot; a session waiting on a permission is the `warn` chip *needs permission*. Needs you: `redline`. Changed: `highlight` (a card's `dot hl` for 3 s after a poll changes it, a drawer row that arrived since it opened, the Thread tab's `chip hl` unread count).

## Motion

Motion is limited to 120ms colour and transform transitions on controls, the 160 ms sketch (`ease-out`), the drawer's slide, and the live dot: one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion. Cards and table rows change at once on hover. The paper and grid never move. Reduced motion turns off every transition and animation: the sketch appears and disappears at once, and the drawer doesn't slide or show the halo.

## Iconography and imagery

Twenty-three line icons as described above and in `assets/Icons/README.md`; the paper fibre in `assets/Textures/`; the anvil in `assets/Logos/`. Nothing else is illustrated: no photographs, no gradients, no decorative shapes beyond the grid, the hover sketch and the register marks.
