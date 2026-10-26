// The Rendered/Raw choice per surface, saved as `forge.mdView.<surface>`. One module instance, so every instance of a
// surface (the inbox log in the Inbox popover and each drawer's log share `session`) flips together.
import { pref } from './prefs.ts';
import { mdPrefKey, readMdView } from './md-view.ts';
import type { MdSurface, MdView } from './md-view.ts';

class MdViewState {
  files = $state<MdView>(readMdView(pref.get(mdPrefKey('files'), '')));
  thread = $state<MdView>(readMdView(pref.get(mdPrefKey('thread'), '')));
  session = $state<MdView>(readMdView(pref.get(mdPrefKey('session'), '')));
}

export const mdView = new MdViewState();

export function setMdView(surface: MdSurface, v: MdView): void {
  mdView[surface] = v;
  pref.set(mdPrefKey(surface), v);
}
