An inbox card is a `redline` ticked sheet (`space-4` padding, `space-3` column): the job's title as a text button with its id in `mono` beneath and a `REV · <gate>` tag at the right, the reason in `body` `muted`, an optional *Read spec.md* link in `ink`, the note textarea when the gate takes one, and the gate's verbs: the first `.primary`, the rest `.btn`.

Use it for every job that waits on a human: a spec to approve, a question, a split, an issue to link, a budget overrun, an escalation. Nothing resolves without the person's click.

Static rendition in the Drafting direction; replaces `InboxCard.svelte` with `JobActions`.
