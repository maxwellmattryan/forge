A page header is a `sheet ticks` title block (`space-4` × `space-3` padding, `space-5` below) holding the `page-title` `h1` with a dimension line beneath it carrying what used to be the subtitle (`3 ACTIVE · BASE MAIN · GITHUB` in `dim` mono between two end ticks), and right-aligned controls that wrap under, inside the sheet, on narrow screens. Text never sits on the grid, so the title, the dimension line and the controls all stay on the sheet.

Use it once per view. The right slot holds the filter segments, the layout toggle and the one primary button, in that order. After the right slot, every header ends with the command palette's trigger: a slim dashed `btn sm` (max 280px) with the `command` glyph, *New job or command* truncated, and the `⌘K` / `Ctrl K` hint in `muted` mono. It is hidden below md, where the phone FAB takes its place.

Static rendition in the Drafting direction; replaces `PageHeader.svelte`.
