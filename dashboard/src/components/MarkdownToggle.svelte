<!-- The Rendered/Raw switch for one markdown surface. Every toggle for a surface shares one saved choice (md-view.svelte.ts).
     With `iconOnly` (the session log's compact control row) it is one pressed-or-not icon button instead of the segment. -->
<script lang="ts">
  import { MD_VIEWS } from '../lib/md-view.ts';
  import type { MdSurface, MdView } from '../lib/md-view.ts';
  import { mdView, setMdView } from '../lib/md-view.svelte.ts';
  import IconButton from './IconButton.svelte';
  import { t } from '../lib/locale.ts';
  import { slideMarker } from '../lib/marker.ts';

  let { surface, iconOnly = false }: { surface: MdSurface; iconOnly?: boolean } = $props();

  // One label per surface: the drawer's Thread tab shows two toggles at once, and a screen reader must tell them apart.
  const groupLabel = $derived<Record<MdSurface, string>>({ files: $t('markdown.files'), thread: $t('markdown.thread'), session: $t('markdown.session'), chat: $t('markdown.chat') });
  const viewLabel = $derived<Record<MdView, string>>({ rendered: $t('markdown.rendered'), raw: $t('markdown.raw') });
  const rendered = $derived(mdView[surface] === 'rendered');
</script>

{#if iconOnly}
  <IconButton icon="markdown" label={$t('markdown.sessionRendered')} pressed={rendered} onclick={() => setMdView(surface, rendered ? 'raw' : 'rendered')} />
{:else}
  <div class="seg slide-marker" role="group" aria-label={groupLabel[surface]} {@attach slideMarker('.sel', 'fill')}>
    {#each MD_VIEWS as v (v)}{@const on = mdView[surface] === v}<button type="button" class="btn sm {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setMdView(surface, v)}>{viewLabel[v]}</button>{/each}
  </div>
{/if}
