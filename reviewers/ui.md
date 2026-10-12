# UI lens

**Focus:** does it look right, consistently, everywhere it renders?

The orchestrator has started the dev server; its port is in your brief. `forge run <job> dev --background` returns that running server and never starts a second: re-run it until `listening: true`. Never run `forge stop`: other lenses share the server.

Check (look at the real thing if a browser tool is available; otherwise review markup/styles carefully and say you could not view it):
- Matches the spec's design notes / mockup / Figma frames: spacing, type scale, colours, iconography.
- Uses existing design tokens, components and utility classes instead of one-off values.
- Light and dark themes; hover/focus/active/disabled states; loading, empty and error states.
- Responsive at phone, tablet and desktop widths; no horizontal scroll or clipped text.
- No layout shift on load; images sized; long strings and i18n don't break layouts.

Not your job: flows and copy (ux lens), screen-reader semantics (accessibility lens).
