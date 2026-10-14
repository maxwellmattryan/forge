The command bar is the ⌘K dialog: a solid ticked sheet (`bg` fill, `shadow-dialog`, 672px) over the `backdrop`, with an input row (the `command` glyph in `muted`, a borderless 15px mono input), a listbox of options, an optional title field for a free-text job, an error strip in `bad`, and a footer with one primary button.

Option rows are `body`: the active one takes a `raised` wash and a 3px `ink` rule on its left; verb rows show the verb in mono `fg` and its hint; job rows show id, title and a `StateChip`; the runnable row leads with the `command` glyph in `ink` and *Start* or *Send* in 500. The dialog traps focus, closes on Escape or a backdrop click, and is a full-width sheet on phones.

Static rendition in the Drafting direction; replaces `CommandBar.svelte`.
