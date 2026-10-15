The status bar is one slim opaque `chrome` row fixed to the bottom of every view: `size-statusbar` (36px) tall plus `env(safe-area-inset-bottom)`, with a `line-strong` top edge and no shadow. Below md it spans the viewport. At md and up it starts at the sidebar's right edge, so the sidebar keeps its full height. It sits at z-35, over the drawer's backdrop (a click on the bar never closes the drawer) and under the drawer (z-40). At md and up the drawer ends at the bar's top edge, so its dock sits wholly above the bar; below md the drawer covers it.

The row is a left cluster, the facts strip and a right cluster, in one flex row with `space-3.5` gaps: the clusters are `flex: none`, the facts strip takes what is left (`min-width: 0`, clipped, never wrapped) and the right cluster is pushed to the edge with `margin-left: auto`. The facts strip (`.facts`) carries what the old nameplate did, as `stamp`-style keys in `dim` before `mono` values, each pair separated by a 1px `line` tick: *FORGE v0.15.0 · API 3 · SESSIONS ● 2 active · SHEET Pipeline · 1 of 6*. The SESSIONS pair is the daemon's heartbeat: the `LiveDot` (on, with its halo, while any daemon session, the inbox or a job's, is working or waiting on a permission; a hollow dot otherwise) and *N active*, with a tooltip listing the active sessions one per line (*inbox*, then job ids) or *No session is working*. The strip is the only place the version appears. When the room runs out, the facts drop from the right: SHEET first, then API, then the SESSIONS word (the dot and count stay), then the FORGE word; below md only the version and the sessions dot with its count remain. Clusters clip sideways rather than wrap or scroll; their labels are never cut (see the fit levels below).

Indicators are `btn sm ghost` buttons: no seam at rest, sheen and a `line` seam on hover, the solid focus ring (drawn inside the 44px targets below md, so the bar's edge never cuts it), and a `line-strong` seam over `raised` while their popover is open. Each has `aria-haspopup="dialog"`, `aria-expanded`, and, while part of its text is hidden, a `title` with its full label, and opens one popover.
- **Daemon** (once `/api/state` has loaded): the live dot (on while a session works or asks, hollow otherwise), the pool state in its tone, and `live/cap` in mono. Off (not enabled, not wanted, nothing running): *Daemon off* in `muted` with a hollow dot.
- **Inbox** (only while the daemon is on): the `inbox` glyph and the inbox session's state in its tone. While a tool call waits for permission anywhere in the pool, the count (*2 prompts*) shows in `warn` and the inbox takes `warn` too.
- **Held** and **Waiting** (md and up, only above 0): `warn` text, *held: budget (2)* and *waiting for slot (1)*. Each opens the Daemon popover.
- **Model**: the `agents` glyph, then the provider, the builder's model and its effort when known (*Anthropic · Opus 5.5*). An unknown model shows as written, without a provider.
- **Connection**: a static 8px dot (`ok`, `warn`, `bad`, or hollow while connecting) and *Live*, *Offline*, *Update needed* or *Connecting…*. It never pulses: the halo belongs to the live dot. *Offline* and *Update needed* keep their word at every width, so the state never rests on hue alone.

Labels fit the room they have, not a viewport breakpoint. Each cluster holds its indicators in a max-content row; when the row is wider than the cluster, the next level of text goes `sr-only`, so a visible label is always whole, never cut to an ellipsis. Every fit starts again from whole labels, on any change of what the labels say, on a resize and once the fonts load. A `title` with the full label appears only while part of an indicator's text is hidden. Below md every indicator is a glyph or a dot (44×44 targets), the prompt count shows as a number, and Held and Waiting live only in the Daemon popover.

| Level | Left cluster drops | Right cluster drops |
|---|---|---|
| 1 | the *Daemon* and *Inbox* words | the provider and the effort |
| 2 | the reasons: *held (2)*, *waiting (1)* | the model label (the `agents` glyph stays) |
| 3 | Held and Waiting: the Daemon indicator takes them (its title, its accessible name, and its glyph shows in `warn`) | *Live* or *Connecting…*, and *needed* after *Update* (*Offline* stays) |
| 4 | the inbox's state (its toned glyph and *2 prompts* stay) | the rest of the connection's word (the toned dot stays) |
| 5 | the daemon's state (its toned `daemon` glyph, the live dot and *2/3* stay) | |
| 6 | *prompts* after the count | |
| 7 | the prompt count (the warn inbox glyph stays) | |
| 8 | *2/3* | |

Hidden words are `sr-only`, never `aria-label`, so an indicator's accessible name always holds its full label (*Daemon idle 0/3 job sessions*).

There is no input in the bar: *New job or command* lives in the sidebar (see Sidebar), where it has the room, and below md it is the 44px button in the nav strip. The bar never holds a text field.

Popovers are non-modal `plate solid` dialogs with `shadow-overlay`, `space-2` above the bar, at z-42: over the drawer, under Settings and the palette (z-45). A header row holds the `section-title` and the sm close button over a `line` rule; the body scrolls within the room above the bar. At md and up a popover anchors to its indicator (left edges meet for the left cluster, right edges for the right), 560px wide for Daemon and Inbox and 400px for Models and Connection, kept 16px inside the viewport. Below md it spans the viewport less 16px on each side. One is open at a time. Escape, the close button or its indicator closes it and returns focus to the indicator; a press elsewhere or focus moving away closes it too. Tab moves through it as if it sat right after its indicator: Shift+Tab from its first stop returns to the indicator, Tab past its last goes on to the next control after the indicator. A body that scrolls with no control in reach takes focus itself.
- **Daemon**: the pool chip (`chip sm`), *0/3 job sessions* and *Default permissions: Ask*; the pool error in `bad`; Start and Stop (`btn sm`, play and stop glyphs); the held, waiting and agents-running chips; one button chip per job session, which opens that job's log; the *Inbox log* toggle (`btn sm`) and, while it is on, the compact session log under a `line` rule.
- **Inbox session**: the inbox chip and its details, then every pending permission prompt in the pool, or *No tool calls are waiting for permission.*
- **Models** (read-only): the summary line, the Roles and Reviewers lists (the role or lens in mono, its label, the raw value in `muted` mono when it differs, *inherits the orchestrator*), and *Change models in Settings › Agents.*
- **Connection**: a sentence for the state, the server's and the dashboard's API versions, *Last update 4s ago*, the error when offline or outdated, and *Retry now*.

One visually hidden polite live region in the bar says *N tool calls waiting for permission* when that count rises to a new value. Popovers hold no live region of their own.

Static rendition in the Smithy direction, hand-written from `design/components/StatusBar/preview.html` and `components/StatusBar.svelte, Popover.svelte`.
