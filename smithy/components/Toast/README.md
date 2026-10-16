A toast is a small solid plate (`.solid`: an opaque `panel` fill, so nothing beneath shows through) fixed bottom-centre, `body` text, `space-4`/`space-2` inset, with `shadow-overlay`. An error toast sets its text in `bad` and leads with a `bad` chip *Error*; it never uses the `you` chip, which is reserved for work that waits on a person.

Use a toast to confirm a request the person just made or to report that it failed; one at a time, self-dismissing, with a permanent live region so screen readers hear each message. One line, no action.

Static rendition in the Smithy direction, hand-written from `design/components/Toast/preview.html` and `components/Toast.svelte`.
