The live dot marks a daemon session that is working right now: an 8px `ink` dot with one `animate-ping` halo behind it (`.halo` here, `motion-safe:animate-ping` in the dashboard), followed by *working · 4s ago*. Off, it is a hollow dot (`dot hollow`): an idle or waiting session (*idle · 2m ago*, *waiting*). A session waiting on a permission prompt is not a dot but the `warn` chip *needs permission*, then *· 4s ago* since its oldest prompt.

Use it for daemon sessions only: first in a job card's footer, under the drawer's chip row, and in the sidebar title block's SESSIONS cell (and the phone header strip), where it is on while any session is working or asking. An agent's role on a card keeps its plain `ink` dot; the halo means a live session, nothing else.

The halo is the only looping motion in the dashboard. It is motion-safe: under `prefers-reduced-motion: reduce` it does not render and the dot is static, solid `ink`. The dot and halo are `aria-hidden`; the words beside them carry the meaning, and the ticking time is never inside an `aria-live` region.

Static rendition in the Drafting direction; replaces `LiveDot.svelte` and `SessionActivity.svelte`.
