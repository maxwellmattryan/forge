The command bar is the ⌘K dialog: a solid ticked sheet (opaque `panel` fill, `shadow-dialog`, 672px) over the lighter `scrim` (`backdrop` is for Settings and the drawer; the scrim keeps the page or drawer behind readable), with an input row (the `command` glyph in `muted`, a borderless 15px mono input), a listbox of options, an optional title field for a free-text job, an error strip in `bad`, and a footer with one primary button.

Option rows are `body`: the active one takes a `raised` wash and a 3px `ink` rule on its left; verb rows show the verb in mono `fg` and its hint; job rows show id, title and a `StateChip`; the runnable row leads with the `command` glyph in `ink` and *Start* or *Send* in 500. The dialog traps focus, closes on Escape or a scrim click, and is a full-width sheet on phones.

Three triggers open it: the dashed header button at the end of every page header (md and up), a 56px square `primary` icon button fixed at the bottom right on phones (the FAB, under the drawer's backdrop), and *Command for this job* (`btn sm`, icon only below sm) left of Close in the drawer header.

Opened from the drawer it is scoped to that job: an `ink` chip *For <job id>* (truncated, full id in its title) and a small remove button sit between the glyph and the input, and with an empty input the job's applicable verbs lead the list as scoped rows (verb and job id in mono), followed by every global verb. Backspace in the empty input or the remove button drops the scope. Free text while scoped still starts a new job, and its Start row says it doesn't message the scoped job.

Static rendition in the Drafting direction; replaces `CommandBar.svelte`.
