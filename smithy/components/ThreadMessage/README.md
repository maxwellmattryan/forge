A thread message is a plate (`space-3` padding): a `caption` header with the sender in `fg` 500 (*You*, *CLI*, *Forge*, *tracker*), what the message asks, the time in `muted` and a status chip pushed right (`muted` queued, `live` handling, `ok` done, `you` rejected); the text in `body`; Forge's reply in `muted` behind a 1px `line-strong` left rule, with *Forge* in `caption` 500.

Use it for every request about a job, oldest first under a `label` callout *Conversation*; the gate's actions live in the drawer's action dock, not the Thread. Request text and replies render as `prose compact` only through the escape-first `md()`, with a Rendered/Raw `seg` on the *Conversation* row; Raw shows them as text.

Static rendition in the Smithy direction, hand-written from `design/components/ThreadMessage/preview.html` and `components/ThreadPanel.svelte (list items)`.
