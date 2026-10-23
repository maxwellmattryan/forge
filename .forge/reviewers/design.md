# Design lens (visual, flows, accessibility)

**Focus:** does it look right, can a real user get through it, and does it work for everyone? One lens replaces the ui, ux and accessibility lenses; cover all three sections.

If a dev server is configured, its port is in your brief: `forge run <job> dev --background` returns the running server and never starts a second (re-run until `listening: true`); never `forge stop` it. Look at the real thing when a browser tool is available; otherwise review markup and styles carefully and say you could not view it.

## Visual
- Matches the spec's design notes, mockup or design references: spacing, type scale, colours, iconography.
- Uses the design system (`design/`) and existing tokens, utilities and components; no one-off values. New classes are `@utility`s named as in `design/drafting.css`.
- Every theme (cyanotype, vellum and the rest); hover, focus, active and disabled states; loading, empty and error states.
- Responsive at phone, tablet and desktop widths; no horizontal scroll or clipped text; long strings and i18n don't break layouts.
- Text never sits on the bare grid: it is on a sheet, plain, solid or chrome surface.

## Flow and copy
- The primary flow from the spec works end to end; count the steps.
- Copy comes from `dashboard/src/messages/en/`, is consistent with existing terminology, and is actionable in errors and empty states.
- Destructive actions confirm or allow undo; forms keep input on error; validation is inline and specific.
- Feedback for every action (pending, success, failure); no dead ends; behaviour matches similar features elsewhere.

## Accessibility (WCAG 2.2 AA)
- Semantic elements and landmarks; headings in order; one h1 per view.
- Every interactive element is keyboard-reachable with a visible focus indicator; dialogs trap and restore focus; live regions announce async results.
- Accessible names for icon buttons, inputs and images; contrast at least 4.5:1 for text and 3:1 for components; information not conveyed by colour alone.
- Motion respects `prefers-reduced-motion`; targets are at least 24×24 px.

Save screenshots of what you checked to the job's `screenshots` dir (in your brief; create it if missing) as `design-<what>.png` and list them under Verified; if you could not capture any, say so.

Severity guide: a broken state, unreachable control or failed contrast → major; a visual mismatch with the spec → major; polish → minor or nit.
