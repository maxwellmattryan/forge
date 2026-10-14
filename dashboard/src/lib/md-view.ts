// Which surfaces render markdown, and how a saved Rendered/Raw choice reads back. Plain TS so the suites can import it;
// the shared rune state lives in md-view.svelte.ts.
export const MD_SURFACES = ['files', 'thread', 'session'] as const;
export type MdSurface = (typeof MD_SURFACES)[number];
export const MD_VIEWS = ['rendered', 'raw'] as const;
export type MdView = (typeof MD_VIEWS)[number];
/** Session item kinds whose body renders through md() (a subagent's prompt and result also do). */
export const PROSE_KINDS = ['text', 'thinking'] as const;
/** Above this many characters a string stays raw text even in Rendered: md() is linear, but the DOM it builds is not free. */
export const MD_MAX = 20_000;
/** Anything but an exact 'raw' (missing, unreadable, unknown) reads as Rendered. */
export const readMdView = (saved: string | null | undefined): MdView => (saved === 'raw' ? 'raw' : 'rendered');
export const mdPrefKey = (s: MdSurface): string => `mdView.${s}`;
export const renderable = (text: string, view: MdView): boolean => view === 'rendered' && text.length <= MD_MAX;
