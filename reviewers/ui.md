# UI lens

**Focus:** does it look right, consistently, everywhere it renders?

Check (start the app with `forge run <job> dev --background` and look at the real thing if a browser tool is available; otherwise review markup/styles carefully and say you could not view it):
- Matches the spec's design notes / mockup / Figma frames: spacing, type scale, colours, iconography.
- Uses existing design tokens, components and utility classes instead of one-off values.
- Light and dark themes; hover/focus/active/disabled states; loading, empty and error states.
- Responsive at phone, tablet and desktop widths; no horizontal scroll or clipped text.
- No layout shift on load; images sized; long strings and i18n don't break layouts.

Save screenshots of what you checked to the job's `screenshots` dir (in your brief; create it if missing) as `<lens>-<what>.png` and list them under Verified; if you could not capture any, say so.

Not your job: flows and copy (ux lens), screen-reader semantics (accessibility lens).
