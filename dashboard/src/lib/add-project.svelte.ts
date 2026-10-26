// The Add project dialog's open state and focus return: the project switcher opens it, App.svelte mounts it and closes it
// on Escape, and the dialog closes itself.
import { tick } from 'svelte';

class AddProjectState {
  open = $state(false);
}

export const addProjectDialog = new AddProjectState();
// Nothing renders the opener, so it is a plain variable rather than state.
let opener: HTMLElement | null = null;

/** Opens the dialog, remembering the switcher trigger focus goes back to. */
export function openAddProject(from: HTMLElement | null): void {
  if (addProjectDialog.open) return;
  opener = from;
  addProjectDialog.open = true;
}

/** Closes the dialog and returns focus to its opener, or to the view's heading when the opener is gone or hidden. */
export function closeAddProject(): void {
  if (!addProjectDialog.open) return;
  addProjectDialog.open = false;
  const back = opener;
  opener = null;
  tick().then(() => {
    const target = back && back.isConnected && back.getClientRects().length > 0 ? back : document.querySelector<HTMLElement>('#view h1');
    target?.focus();
  });
}
