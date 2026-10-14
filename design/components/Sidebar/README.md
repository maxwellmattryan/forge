The sidebar is a `size-sidebar` (236px) column on a slightly darkened ground with a `line` right edge: the brand sheet (the mark, *Forge* in `sheet-title`, *software factory* in `label`), a dimension line naming the drawing (`DWG · PIPELINE`), the repo in `mono`, the dashed ⌘K button, the view nav, and at the foot the Settings item and a title block (DRAWN BY / SESSIONS / REV / API / SHEET) in place of a footer.

The SESSIONS cell is a heartbeat for the daemon: the `LiveDot` (on, with its halo, while any daemon session, the inbox or a job's, is working or waiting on a permission; a hollow dot otherwise) and *N active*. Its tooltip lists the active sessions one per line (*inbox*, then job ids) or reads *No session is working*. The Agents view still lists orchestrator sessions.

Use it as the one navigation surface at md and up; below md the items become a horizontal strip and the command and settings buttons become 44px targets, and the strip carries the same live dot and *N active* (with the same tooltip) between the nav and the command button. The title block is the only place the version appears.

Static rendition in the Drafting direction; replaces the `aside#sidebar` in `App.svelte`.
