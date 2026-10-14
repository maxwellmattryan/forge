The sidebar is a `size-sidebar` (236px) column on a slightly darkened ground with a `line` right edge: the brand sheet (the mark, *Forge* in `sheet-title`, *software factory* in `label`), a dimension line naming the drawing (`DWG · PIPELINE`), the repo in `mono`, the view nav, and at the foot the Settings item and a title block (DRAWN BY / SESSIONS / REV / API / SHEET) in place of a footer.

Use it as the one navigation surface at md and up; below md the items become a horizontal strip and the settings button a 44px target. It holds navigation only: the command palette opens from the page header, the phone FAB and the drawer (see CommandBar). The title block is the only place the version and session count appear.

Static rendition in the Drafting direction; replaces the `aside#sidebar` in `App.svelte`.
