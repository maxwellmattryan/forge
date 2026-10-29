# dashboard/src/components/ui/

The primitives every feature uses: chips, icons, icon and close buttons, the select, copyable text, field hints, count badges, the Rendered/Raw toggle, and the feedback and overlay sets.

- These know nothing of jobs, gates or sessions (they import nothing from `src/lib/jobs/`, `gates/` or `sessions/`), and any feature folder may import them.
- Their models (the icon set, the select's keyboard model) live in `src/lib/ui/`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `Chip.svelte` | Every chip in the dashboard: `chip`, the extra classes, then the tone's class (none for a tone TONE_CLASS lacks, such as foreman or spark, which go in `extra`), an optional leading icon, then `children` or `text`. |
| `CloseButton.svelte` | The one close control: a quiet square icon button at its siblings' height (sm or md). |
| `Copyable.svelte` | Text that copies itself: a button showing `text`, with a copy icon, that writes it to the clipboard and toasts. |
| `CountBadge.svelte` | A count pinned to the top-right corner of what it wraps (the status bar's bell, the job panel's Thread tab). |
| `FieldHint.svelte` | A field's info icon: the `about` glyph after a label, whose hint shows on hover (after TIP_DELAY_MS), at once on keyboard focus, and on a click or tap, which toggles it (Tooltip's toggle mode). |
| `Icon.svelte` | A machined Smithy line icon from src/lib/ui/icons.ts. |
| `IconButton.svelte` | An icon-only button: its name is `label` (aria-label and the tooltip's first line), and `hint`, when set, is the tooltip's second line and the button's description (aria-describedby on an sr-only span). |
| `MarkdownToggle.svelte` | The Rendered/Raw switch for one markdown surface. |
| `Select.svelte` | The dashboard's single-choice dropdown, in place of a native <select>, whose OS menu ignores the Smithy look and the themes. |
| `feedback/` | What a page or section shows in place of its content: the warning banner, the empty state, and the loading state with its skeleton bones. |
| `overlay/` | What floats over the page: the status bar's popover, the menu button, tooltips, the toast and the GitHub hover card. |
<!-- forge:map:end -->
