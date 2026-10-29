// The Office page's layout classes, shared by the page (views/Office.svelte, components/OfficePanel.svelte) and its
// skeleton so the two hold the same shape. Whole literals, so Tailwind's @source scan sees every class. At a 56rem #view
// container the panel is two columns (the mandates, gate runs and directives on the left, the office session on the
// right) and the page takes the viewport's height less the view's top padding (pt-4) and its bottom padding (the status
// bar, the safe area and --space-6), with a floor so a short window scrolls the page instead of crushing the columns.

/** The page: a column whose height is pinned only while the panel is two columns. */
export const OFFICE_PAGE = 'flex flex-col @min-[56rem]:h-[calc(100dvh_-_1rem_-_var(--size-statusbar)_-_env(safe-area-inset-bottom)_-_var(--space-6))] @min-[56rem]:min-h-[36rem]';

/** The panel: one column, or two that share the height left under the header. */
export const OFFICE_GRID = 'grid min-h-0 flex-1 gap-x-6 gap-y-8 @min-[56rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @min-[56rem]:grid-rows-[minmax(0,1fr)]';

/** The left column (mandates, gate runs, directives): its own scroller while the panel is two columns. */
export const OFFICE_LEFT = 'flex min-w-0 flex-col @min-[56rem]:min-h-0 @min-[56rem]:overflow-y-auto @min-[56rem]:overscroll-contain @min-[56rem]:pr-1 @min-[56rem]:pb-1';

/** The right column (the office session): the log takes what is left of it; stacked, it gets a fixed share of the viewport. */
export const OFFICE_RIGHT = 'flex min-w-0 flex-col h-[70dvh] min-h-80 @min-[56rem]:h-auto @min-[56rem]:min-h-0';
