// The toast's state and trigger: any module can call toast(); Toast.svelte renders it.
class ToastState {
  msg = $state('');
  bad = $state(false);
  shown = $state(false);
}

export const toastState = new ToastState();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Shows `msg` for 4 s; a new toast replaces the old one and restarts the timer. */
export function toast(msg: string, bad = false): void {
  toastState.msg = msg;
  toastState.bad = bad;
  toastState.shown = true;
  clearTimeout(timer);
  timer = setTimeout(() => (toastState.shown = false), 4000);
}
