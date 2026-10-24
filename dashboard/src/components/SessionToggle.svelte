<!-- One daemon session's Start/Stop icon toggle. SessionControls ends with it for the inbox and the office; the job
     drawer sets it apart, at the end of its tab row, so it never sits between the other controls. `live` is the caller's
     freshest session state, else the 2 s /api/state poll's; `onacted` runs after a Start or Stop so the caller can drop
     that state. -->
<script lang="ts">
  import { tick } from 'svelte';
  import IconButton from './IconButton.svelte';
  import { keepFocus } from '../lib/menu.ts';
  import type { DaemonSessionState } from '../lib/types.ts';
  import { postDaemon, scopeSession, sessionControls, sessionToggle } from '../lib/daemon.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { scope, live = null, onacted }: { scope: string; live?: Partial<DaemonSessionState> | null; onacted?: () => void } = $props();

  const session = $derived(live ?? scopeSession(S.data?.daemons ?? null, scope));
  const poolWanted = $derived(S.data?.daemons?.wanted === true);
  let pending = $state(false);
  const toggle = $derived(sessionToggle(sessionControls(session, poolWanted, pending), session));

  async function act(action: 'start' | 'stop', el: HTMLButtonElement): Promise<void> {
    const restore = keepFocus(el);
    pending = true;
    try {
      await postDaemon(action, forgeToken(), scope);
      onacted?.();
      refresh();
    } catch (err) {
      toast($t('session.failed', { action, error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      pending = false;
      await tick();
      restore();
    }
  }
</script>

<IconButton icon={toggle.action === 'start' ? 'play' : 'stop'} label={toggle.action === 'start' ? $t('session.start') : $t('session.stop')} hint={toggle.action === 'start' ? $t('session.startHint') : null} disabled={!toggle.enabled} onclick={(e) => act(toggle.action, e.currentTarget)} />
