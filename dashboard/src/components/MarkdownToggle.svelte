<!-- The Rendered/Raw switch for one markdown surface. Every toggle for a surface shares one saved choice (md-view.svelte.ts). -->
<script lang="ts">
  import { MD_VIEWS } from '../lib/md-view.ts';
  import type { MdSurface, MdView } from '../lib/md-view.ts';
  import { mdView, setMdView } from '../lib/md-view.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { surface }: { surface: MdSurface } = $props();

  // One label per surface: the drawer's Thread tab shows two toggles at once, and a screen reader must tell them apart.
  const groupLabel = $derived<Record<MdSurface, string>>({ files: $t('markdown.files'), thread: $t('markdown.thread'), session: $t('markdown.session') });
  const viewLabel = $derived<Record<MdView, string>>({ rendered: $t('markdown.rendered'), raw: $t('markdown.raw') });
</script>

<div class="seg" role="group" aria-label={groupLabel[surface]}>
  {#each MD_VIEWS as v (v)}{@const on = mdView[surface] === v}<button type="button" class="btn sm {on ? 'sel' : ''}" aria-pressed={on} onclick={() => setMdView(surface, v)}>{viewLabel[v]}</button>{/each}
</div>
