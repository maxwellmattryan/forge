// The toast's state and trigger: any module can call toast(); Toast.svelte renders it.
class ToastState {
  msg = $state('');
  bad = $state(false);
  shown = $state(false);
}

export const toastState = new ToastState();
const SHOW_MS = 4000;
let timer: ReturnType<typeof setTimeout> | undefined;
// Hover and focus are tracked apart, so moving from one to the other does not restart the timer early.
let hovered = false;
let focused = false;
// Where focus was when the toast appeared: a keyboard dismiss returns there instead of dropping focus to <body>.
let opener: HTMLElement | null = null;

const insideToast = (el: Element | null): boolean => !!el?.closest('#toast');

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => (toastState.shown = false), SHOW_MS);
}

/** Shows `msg` for 4 s; a new toast replaces the old one and restarts the timer (unless the pointer or focus holds it). */
export function toast(msg: string, bad = false): void {
  toastState.msg = msg;
  toastState.bad = bad;
  toastState.shown = true;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (active instanceof HTMLElement && !insideToast(active)) opener = active;
  clearTimeout(timer);
  if (!hovered && !focused) schedule();
}

/** The pointer entered the toast or focus moved into it: it stays until both leave. */
export function holdToast(e: Event): void {
  if (e.type === 'focusin') focused = true;
  else hovered = true;
  clearTimeout(timer);
}

/** The pointer or focus left: once neither is inside, the 4 s start again. */
export function releaseToast(e: Event): void {
  if (e.type === 'focusout') {
    // focusout fires before focus lands on the next element; moving within the toast is not leaving it.
    const next = (e as FocusEvent).relatedTarget;
    if (next instanceof Element && insideToast(next)) return;
    focused = false;
  } else hovered = false;
  if (toastState.shown && !hovered && !focused) schedule();
}

/** Hides the toast now; if focus was inside it, focus goes back to where it was when the toast appeared. */
export function dismissToast(): void {
  const hadFocus = typeof document !== 'undefined' && insideToast(document.activeElement);
  toastState.shown = false;
  clearTimeout(timer);
  focused = false;
  hovered = false;
  if (hadFocus && opener?.isConnected) opener.focus();
}
