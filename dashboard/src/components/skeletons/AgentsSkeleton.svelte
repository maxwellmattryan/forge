<!-- The Agents view's shape while the project's first state loads (App.svelte). -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { t } from '../../lib/text/locale.ts';

  const cards = [0, 1, 2];
  const sessionRows = [0, 1];
  const rosterRows = [0, 1, 2, 3, 4];
  const widths = ['70%', '55%', '80%', '45%', '65%'];
</script>

<Loading>
  <PageHeader title={$t('agents.title')}>
    {#snippet sub()}{$t('agents.sub')}{/snippet}
  </PageHeader>
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('agents.running')}</h2>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each cards as c (c)}
      <div class="plate p-3">
        <div class="flex items-center justify-between gap-2"><Skeleton w="30%" h="1rem" /><Skeleton w="6rem" h="1.25rem" round /></div>
        <Skeleton w={widths[c + 1]} h="0.8rem" class="mt-2" />
        <Skeleton w="50%" h="0.6875rem" class="mt-2" />
        <Skeleton w="75%" h="0.6875rem" class="mt-2" />
      </div>
    {/each}
  </div>
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('agents.sessions')}</h2>
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agents.session')}</th><th>{$t('agents.jobs')}</th><th>{$t('agents.lastSeen')}</th></tr></thead>
      <tbody>
        {#each sessionRows as i (i)}
          <tr>
            <td><Skeleton w="9rem" h="0.8rem" /></td>
            <td><Skeleton w="5rem" h="0.8rem" /></td>
            <td><Skeleton w="3rem" h="0.8rem" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('agents.roster')}</h2>
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('agents.role')}</th><th>{$t('common.model')}</th><th>{$t('agents.effort')}</th><th>{$t('agents.promptHash')}</th><th>{$t('agents.addendum')}</th></tr></thead>
      <tbody>
        {#each rosterRows as i (i)}
          <tr>
            <td><Skeleton w="5rem" h="0.8rem" /><Skeleton w={widths[i]} h="0.6875rem" class="mt-1.5" /></td>
            <td><Skeleton w="4.5rem" h="1.25rem" round /></td>
            <td><Skeleton w="3.5rem" h="1.25rem" round /></td>
            <td><Skeleton w="4rem" h="0.8rem" /></td>
            <td><Skeleton w="2rem" h="0.8rem" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
</Loading>
