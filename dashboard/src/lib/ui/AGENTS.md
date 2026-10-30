# dashboard/src/lib/ui/

Shared interface pieces: the icon set, the theme, motion, the sliding marker, the select's keyboard model, and the overlays.

- `icons.ts` is the source of the Smithy icon set; `components/ui/Icon.svelte` renders it.
- Every Svelte transition comes from `motion.ts`, never `svelte/transition`, and waits for `settled()`.
- These touch the DOM only inside the functions they export, so node:test can import them.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `icons.ts` | The Smithy icon set (24x24 viewBox, machined: 1.5px strokes, round caps and joins), rendered by components/ui/Icon.svelte. |
| `marker.ts` | The sliding selected marker (style.css `slide-marker`): where it sits for the selected item, and the attachment that keeps it there. |
| `motion.ts` | The dashboard's one door to Svelte transitions: the durations style.css's --motion-* tokens name, a reduced-motion guard that zeroes every transition, and the settle rule that keeps a page load, a reconnect or a stream (re)open from animating. |
| `overlay/` | What floats over the page: popovers, menus, tooltips, the toast, the GitHub hover card, and the scroll lock beneath them. |
| `select.ts` | The keyboard model of components/ui/Select.svelte, the dashboard's themed replacement for a native <select> (the WAI-ARIA "select-only combobox"), as plain functions node:test can pin: which option opens active, how arrows, Home/End and type-ahead move it, and which keys choose, close or are left to the page. |
| `theme.ts` | Appearance: <html>'s `data-theme`, `data-grain` and `data-screen` (index.html sets them before first paint) and their `theme`, `grain` and `screen` prefs. |
<!-- forge:map:end -->
