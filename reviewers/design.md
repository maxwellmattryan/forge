# Design lens (visual, flows, accessibility)

**Focus:** does it look right, can a real user get through it, and does it work for everyone? One lens replaces the ui, ux and accessibility lenses; cover all three sections.

If a dev server is configured, the orchestrator has started it and its port is in your brief. `forge run <job> dev --background` returns that running server and never starts a second: re-run it until `listening: true`. Never run `forge stop`: other lenses share the server. Look at the real thing when a browser tool is available; otherwise review markup and styles carefully and say you could not view it.

## Visual
- Matches the spec's design notes, mockup or design references: spacing, type scale, colours, iconography.
- Uses the project's design system and existing tokens, components and utility classes; no one-off values.
- Every theme the project ships; hover, focus, active and disabled states; loading, empty and error states.
- Responsive at phone, tablet and desktop widths; no horizontal scroll, clipped text or layout shift; long strings and i18n don't break layouts.

## Flow and copy
- The primary flow from the spec works end to end in the running app; count the steps.
- Copy matches existing terminology, comes from the project's i18n source if it has one, and is actionable in errors and empty states.
- Destructive actions confirm or allow undo; forms keep input on error; validation is inline and specific.
- Feedback for every action (pending, success, failure); no dead ends; behaviour matches similar features elsewhere.

## Accessibility (WCAG 2.2 AA)
- Semantic elements and landmarks; headings in order; one h1 per view.
- Every interactive element is keyboard-reachable with a visible focus indicator; dialogs trap and restore focus; live regions announce async results.
- Accessible names for icon buttons, inputs and images; contrast at least 4.5:1 for text and 3:1 for components; information not conveyed by colour alone.
- Motion respects `prefers-reduced-motion`; targets are at least 24×24 px.

Save screenshots of what you checked to the job's `screenshots` dir (in your brief; create it if missing) as `design-<what>.png` and list them under Verified; if you could not capture any, say so.

Severity guide: a broken state, unreachable control or failed contrast → major; a visual mismatch with the spec → major; polish → minor or nit.
