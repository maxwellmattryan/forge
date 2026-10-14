A button is an outlined box: 1px `line-strong`, `radius-0`, the `control` style (Plex Mono 12px, uppercase, .08em) in `fg`, `space-3`/7px inset. `.primary` fills with `ink`, sets `on-ink` text and casts `shadow-primary`, a hard 3px offset like a second sheet behind it.

Use `.btn` for every action that is not the surface's one primary action (filters, Start/Stop, Link, Close, toggles) and `.primary` once per surface (Run next, Approve, Save config). Flush a group of related buttons into a `.seg` strip (they share borders). An icon-only button is `.btn.icon` with an `aria-label`; on phones add `.touch` for a 44px target.

Hover sketches the face: 1px `sketch-line` lines at 45° every `hatch-pitch` (6px) fade in and slide 6px into place over 160 ms, only where the pointer can hover, and `muted` text inside takes the button's `fg`. Selected, primary, pressed and disabled buttons never sketch; a primary button lifts 1px and its shadow grows to 4px `line`. Focus is a 1px dashed `line-strong` outline at 3px. Pressed inverts to solid `ink`; a primary button drops onto its shadow (translate 2px, no shadow). Disabled is 40% with a dashed border. A selected toggle (`.sel`) is solid ink, the same as pressed. Never round a button, never blur its shadow.

Static rendition in the Drafting direction; replaces `@utility btn` / `.btn-primary` from `dashboard/style.css`.
