Form controls are drawn, never tinted: text inputs, textareas and selects are 1px `line` boxes filled with the opaque surface they sit on (`panel`, `chrome` or `bg`) with `radius-0`, `mono` 13px text (textareas use the sans `body`), `space-2.5`/7px inset and a `dim` placeholder; checkboxes are 14px squares on the same fill that take an inset `ink` square when checked; radios are 14px circles with an `ink` dot.

Use a text input for a ref, a title or a search filter; a textarea (`rows="2"`) for a note to the agents; a select (with the drawn chevron) for a bounded choice. Every control has a visible `label` or an `aria-label`; placeholders describe, they never label.

Hover strengthens the border to `line-strong`; focus adds a 1px dashed `line-strong` outline at 2px (the drafting dash); disabled is 40% with a dashed border. Widths come from the layout.

Static rendition in the Drafting direction; replaces the global `input`, `textarea`, `select` rules.
