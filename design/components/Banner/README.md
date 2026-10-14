A banner is a full-width `redline` sheet: red outline, the message in `body` `fg` with a `REV` chip at its head, `space-4`/`space-3` inset, `space-4` below.

Use it at the top of the view for a condition the person must know about but cannot fix from the page: the connection dropped, the server speaks a newer API, the repo has no `.forge/config.yml`, a job's files failed to load. One banner per condition; it stays until the condition clears. It has `role="status"`, no close button, no icon.

Static rendition in the Drafting direction; replaces `Banner.svelte`.
