// The keyboard model of components/Select.svelte, the dashboard's themed replacement for a native <select> (the WAI-ARIA
// "select-only combobox"), as plain functions node:test can pin: which option opens active, how arrows, Home/End and
// type-ahead move it, and which keys choose, close or are left to the page.

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly lang?: string;
}
export interface SelectState {
  readonly open: boolean;
  readonly active: number;
  readonly typed: string;
  readonly typedAt: number;
}
export interface SelectKey {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
}
/** handled: the component calls preventDefault (and stopPropagation when it closed on Escape). commit: option index to choose, or null. */
export interface SelectStep {
  readonly state: SelectState;
  readonly commit: number | null;
  readonly handled: boolean;
}

/** How long a type-ahead buffer lives after its last key, in ms. */
export const TYPEAHEAD_MS = 500;
export const CLOSED: SelectState = { open: false, active: -1, typed: '', typedAt: 0 };

const enabled = (options: readonly SelectOption[], i: number): boolean => i >= 0 && i < options.length && !options[i].disabled;

/** The index of the option holding `value`; -1 when none does. */
export function selectedIndex(options: readonly SelectOption[], value: string): number {
  return options.findIndex((o) => o.value === value);
}

/** The first or last enabled option; -1 when none is enabled. */
export function edgeIndex(options: readonly SelectOption[], which: 'first' | 'last'): number {
  if (which === 'first') return options.findIndex((o) => !o.disabled);
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

/** The option active when the list opens: the selected one if enabled, else the first enabled one, else -1. */
export function openAt(options: readonly SelectOption[], selected: number): number {
  return enabled(options, selected) ? selected : edgeIndex(options, 'first');
}

/** The next enabled option in that direction; `from` itself at the end, since arrows don't wrap (as native). */
export function moveActive(options: readonly SelectOption[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < options.length; i += delta) if (enabled(options, i)) return i;
  return from;
}

/** The first enabled option from `from` (wrapping) whose label starts with `buffer`, case-insensitive; -1 when none. */
export function typeahead(options: readonly SelectOption[], from: number, buffer: string): number {
  const n = options.length;
  if (n === 0 || buffer === '') return -1;
  const want = buffer.toLowerCase();
  const start = ((Math.max(from, 0) % n) + n) % n;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (enabled(options, i) && options[i].label.toLowerCase().startsWith(want)) return i;
  }
  return -1;
}

/** Runs one printable key into the buffer: a run of one character cycles from the next option, any other buffer refines from the active one. */
function typeStep(state: SelectState, key: string, options: readonly SelectOption[], live: boolean, now: number): SelectStep {
  const typed = live ? state.typed + key : key;
  const repeated = [...typed].every((c) => c.toLowerCase() === typed[0].toLowerCase());
  const hit = repeated ? typeahead(options, state.active + 1, typed[0]) : typeahead(options, state.active, typed);
  return { state: { open: true, active: hit >= 0 ? hit : state.active, typed, typedAt: now }, commit: null, handled: true };
}

/** One keydown on the trigger: the next state, the option to choose, and whether the key was the Select's. */
export function selectKey(state: SelectState, ev: SelectKey, options: readonly SelectOption[], selected: number, now: number): SelectStep {
  const ignored: SelectStep = { state, commit: null, handled: false };
  if (ev.ctrlKey || ev.metaKey || ev.isComposing) return ignored;
  const printable = ev.key.length === 1 && !ev.altKey;
  const opened = (active: number): SelectStep => ({ state: { open: true, active, typed: '', typedAt: 0 }, commit: null, handled: true });

  if (!state.open) {
    switch (ev.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        return opened(openAt(options, selected));
      case 'Home':
        return opened(edgeIndex(options, 'first'));
      case 'End':
        return opened(edgeIndex(options, 'last'));
    }
    if (printable) return typeStep(opened(openAt(options, selected)).state, ev.key, options, false, now);
    return ignored;
  }

  const live = state.typed !== '' && now - state.typedAt < TYPEAHEAD_MS;
  const moved = (active: number): SelectStep => ({ state: { ...state, active, typed: '', typedAt: 0 }, commit: null, handled: true });
  const chosen: SelectStep = { state: CLOSED, commit: enabled(options, state.active) ? state.active : null, handled: true };
  switch (ev.key) {
    case 'ArrowDown':
      return moved(moveActive(options, state.active, 1));
    case 'ArrowUp':
      return ev.altKey ? chosen : moved(moveActive(options, state.active, -1));
    case 'Home':
      return moved(edgeIndex(options, 'first'));
    case 'End':
      return moved(edgeIndex(options, 'last'));
    case 'Enter':
      return chosen;
    case ' ':
      return live ? typeStep(state, ' ', options, true, now) : chosen;
    case 'Escape':
      return { state: CLOSED, commit: null, handled: true };
    case 'Tab':
      return { state: CLOSED, commit: null, handled: false };
  }
  if (printable) return typeStep(state, ev.key, options, live, now);
  return ignored;
}
