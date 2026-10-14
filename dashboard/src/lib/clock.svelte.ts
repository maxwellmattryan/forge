// The one shared clock the board's and the drawer's relative times read, so "4s ago" ticks without new data.
// Named `ticker` because util.ts already exports clock() (a log line's HH:MM:SS).
import { startTicker } from './live.ts';

class Ticker {
  now = $state(Date.now());
}

export const ticker = new Ticker();

/** Starts the 1 s tick (paused while the tab is hidden); returns the stop function for onMount's cleanup. */
export const startClock = (): (() => void) =>
  startTicker((n) => (ticker.now = n), {
    doc: document,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    now: () => Date.now(),
  });
