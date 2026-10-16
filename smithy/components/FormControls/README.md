Form controls are recesses in the plate: text inputs, textareas and selects are 1px `line` boxes filled darker than the surface they sit on (a 45% mix of `panel`, `chrome` or `bg` toward `bg-deep`), so the recess reads at once on a grained plate, cut `radius-nick` at the top-right and bottom-left corners (the opposite corners to a button's, so a field beside its button never reads as one shape), a 1px `edge-dark` inset along the top (the recess), `mono` 13px text (textareas use the sans `body`), `space-2.5`/6px inset and a `dim` placeholder; checkboxes are 14px squares cut at two corners on the same fill that fill `gleam` with an `on-gleam` tick when checked; radios are 14px circles with a `gleam` dot and seam.

Use a text input for a ref, a title or a search filter; a textarea (`rows="2"`) for a note to the agents; a select (with the drawn chevron) for a bounded choice. Every control has a visible `label` or an `aria-label`; placeholders describe, they never label.

Hover hardens the seam to `line-strong`; focus turns the seam `gleam` and adds the solid 2px `line-strong` outline at 2px; disabled is 40% with a dashed seam and no recess. Widths come from the layout.

Static rendition in the Smithy direction, hand-written from `design/components/FormControls/preview.html` and `dashboard/style.css (input, textarea, select)`.
