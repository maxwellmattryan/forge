The settings dialog is a solid ticked sheet (`size-dialog`, `min(80vh, 720px)` tall, `shadow-dialog`) over the `backdrop`: a header with *Settings* in `sheet-title`, the sheet number in `label` (`SHEET S-01`) and a close button; a `size-settings-rail` rail of nav items with icons on the left (`role="tablist"`); and a scrolling panel of `callout`-labelled sections laid out as a two-column grid (label, control).

A rail item with an unsaved change shows a `highlight` dot, one with an invalid field a `redline` dot. The footer carries a `REV` chip summarising what is unsaved or broken, Discard and Save config. Closing with drafts asks first; below md the rail is a horizontal strip and the dialog a full-screen sheet.

Static rendition in the Drafting direction; replaces `Settings.svelte`.
