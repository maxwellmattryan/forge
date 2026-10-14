A thread message is a ticked sheet (`space-3` padding): a `caption` header with the sender in `fg` 500 (*You*, *CLI*, *Forge*, *tracker*), what the message asks, the time in `muted` and a status chip pushed right (`muted` queued, `live` handling, `ok` done, `rev` rejected); the text in `body`; Forge's reply in `muted` behind a 1px `line-strong` left rule, with *Forge* in `caption` 500.

Use it for every request about a job, oldest first under a `label` callout *Conversation*; the *Composer* section beneath holds `JobActions` when the job needs a person. Request text renders as text.

Static rendition in the Drafting direction; replaces the list items in `ThreadPanel.svelte`.
