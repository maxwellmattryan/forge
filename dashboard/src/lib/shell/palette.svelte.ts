// The command palette's shared open state, job scope, starting text and focus return: App.svelte, CommandBar, the status
// bar and the drawer's CommandTrigger use it, so every trigger (the status bar's input, or its button below md; Cmd/Ctrl-K;
// the drawer) opens the same palette.
import { tick } from 'svelte';

class PaletteState {
  open = $state(false);
  /** The job id the drawer's trigger opened it for; CommandBar ignores it unless that job is open. */
  scope = $state<string | null>(null);
  /** What the status bar's input held when typing there opened the palette: CommandBar starts from it. */
  text = $state('');
}

export const palette = new PaletteState();
// Nothing renders the opener, so it is a plain variable rather than state.
let opener: HTMLElement | null = null;

/**
 * Opens the palette, remembering where focus goes back to. Triggers pass their own button, because
 * Safari does not focus a button on click; the shortcut leaves it to the focused element.
 */
export function openPalette(opts: { scope?: string | null; opener?: HTMLElement | null; text?: string } = {}): void {
  if (palette.open) return;
  opener = opts.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  palette.scope = opts.scope ?? null;
  palette.text = opts.text ?? '';
  palette.open = true;
}

/** Closes the palette and returns focus to its opener, or to the view's heading when the opener is gone or hidden. */
export function closePalette(): void {
  if (!palette.open) return;
  palette.open = false;
  palette.scope = null;
  palette.text = '';
  const back = opener;
  opener = null;
  tick().then(() => {
    const target = back && back !== document.body && back.isConnected && back.getClientRects().length > 0 ? back : document.querySelector<HTMLElement>('#view h1');
    target?.focus();
  });
}

export function clearScope(): void {
  palette.scope = null;
}
