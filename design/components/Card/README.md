A card is a sheet: a 1px `line` outline on an opaque `panel` (the grid and paper never show through it), `radius-0`, with 9px `line-strong` register ticks at the corners (`.ticks`, which needs one empty `<span class="tk">` inside). Padding is `space-3` for a dense card, `space-4` for a standard one.

Three outlines mean three things: solid with ticks is a thing (a job, a message, a KPI); dashed without ticks (`.dashed`) is a container (a board column); `redline` (solid red plus a dashed red outline at 3px) is a thing that waits on a human. A clickable sheet is a `<button>`; hover strengthens the line to `line-strong` at once, with no sketch and no transition, while the fill stays `panel`; focus is a dashed outline. A dashed container stays transparent, drawn on the ground; the sheets inside it are opaque.

Sheets never nest more than one level, never fill with colour, never cast a shadow except the dialog's and drawer's stacked-sheet offset. Titles inside are `card-title` or `section-title`; counts beside them are `label` in `muted`.

Static rendition in the Drafting direction; replaces `@utility card`.
