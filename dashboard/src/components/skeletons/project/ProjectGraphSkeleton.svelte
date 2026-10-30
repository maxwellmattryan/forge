<!-- The Project view's component graph while it loads: the job picker and legend rows around a plate of node-shaped bones
     in bands. Content only: the caller supplies the <Loading> root. -->
<script lang="ts">
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  const bands = [2, 3, 2];
</script>

<div class="flex flex-wrap items-end gap-3 mb-3">
  <div class="plate flex flex-col gap-1 px-3 py-2 text-xs text-muted">
    <span>{$t('project.job')}</span>
    <Skeleton w="12rem" h="2rem" />
  </div>
</div>
<div class="plate overflow-x-auto p-3 mb-3">
  <div class="flex flex-col gap-4">
    {#each bands as n, i (i)}
      <div class="flex flex-wrap gap-4 p-4 border border-dashed border-line">
        {#each Array.from({ length: n }, (_, k) => k) as k (k)}
          <div class="flex flex-col gap-2 w-44 p-3 border border-line">
            <Skeleton w={k % 2 ? '60%' : '80%'} h="0.8rem" />
            <Skeleton w="35%" h="0.6875rem" />
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
<div class="plate flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2 mb-6 text-xs text-muted">
  <span class="flex items-center gap-2"><Skeleton w="28px" h="0.5rem" />{$t('project.legend.build')}</span>
  <span class="flex items-center gap-2"><Skeleton w="28px" h="0.5rem" />{$t('project.legend.runtime')}</span>
  <span class="flex items-center gap-2"><Skeleton w="18px" h="14px" />{$t('project.legend.touched')}</span>
  <span class="flex items-center gap-2"><Skeleton w="18px" h="14px" />{$t('project.legend.consumer')}</span>
</div>
