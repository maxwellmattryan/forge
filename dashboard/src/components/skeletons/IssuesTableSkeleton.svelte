<!-- The Issues table's shape while the backlog loads: the real column headers over rows of bones. -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { t } from '../../lib/locale.ts';

  const rows = [
    { title: '70%', chip: '4.5rem', status: '3.5rem' },
    { title: '55%', chip: '5rem', status: '4rem' },
    { title: '80%', chip: '4rem', status: '3.5rem' },
    { title: '62%', chip: '5rem', status: '3rem' },
    { title: '75%', chip: '4.5rem', status: '4rem' },
    { title: '50%', chip: '4rem', status: '3.5rem' }
  ];
</script>

<Loading class="plate flat"><div class="overflow-x-auto">
  <table class="tbl">
    <thead><tr><th>{$t('issues.ref')}</th><th>{$t('issues.itemTitle')}</th><th>{$t('issues.status')}</th><th>{$t('issues.readiness')}</th><th>{$t('issues.priority')}</th><th>{$t('issues.claimedBy')}</th><th></th></tr></thead>
    <tbody>
      {#each rows as r, n (n)}
        <tr>
          <td><Skeleton w="2.5rem" h="0.75rem" /></td>
          <td><Skeleton w={r.title} h="0.8rem" /><div class="flex flex-wrap gap-1 mt-1"><Skeleton w="3.5rem" h="1.25rem" /><Skeleton w="4rem" h="1.25rem" /></div></td>
          <td><Skeleton w={r.status} h="0.8rem" /></td>
          <td><Skeleton w={r.chip} h="1.25rem" /></td>
          <td><Skeleton w="2rem" h="0.8rem" /></td>
          <td><Skeleton w="4rem" h="0.8rem" /></td>
          <td class="r"><Skeleton w="3.5rem" h="2rem" class="inline-block" /></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div></Loading>
