A page header is the `page-title` `h1` with a dimension line beneath it carrying what used to be the subtitle (`3 ACTIVE · BASE MAIN · GITHUB` in `dim` mono between two end ticks), and right-aligned controls that wrap under on narrow screens; `space-5` below.

Use it once per view. The right slot holds the filter segments, the layout toggle and the one primary button, in that order. After the right slot, every header ends with the command palette's trigger: a dashed `btn` (max 280px, md like every header control) with the `command` glyph, *New job or command* truncated, and the `⌘K` / `Ctrl K` hint in `muted` mono. It is hidden below md, where the phone FAB takes its place.

Static rendition in the Drafting direction; replaces `PageHeader.svelte`.
