The settings dialog is a solid plate (`size-dialog`, `min(80vh, 720px)` tall, `shadow-overlay`) over the `backdrop`: a header with *Settings* in `sheet-title` and a close button; a `size-settings-rail` rail of nav items with icons on the left (`role="tablist"`); and a scrolling panel of `callout`-labelled sections laid out as a two-column grid (label, control).

A rail item with an unsaved change shows a `spark` dot, one with an invalid field an `ember` dot. The footer carries a `you` chip summarising what is unsaved or broken, Discard and Save config. Closing with drafts asks first; below md the rail is a horizontal strip and the dialog a full-screen plate. The Appearance section offers the theme (Forge, Ash, System) and the Grain toggle; there is no grid.

Static rendition in the Smithy direction, hand-written from `design/components/SettingsDialog/preview.html` and `components/Settings.svelte`.
