<!-- The Office page's directives table while it loads: the real column headers over rows of bones. `bare` drops the
     Loading wrapper when a page skeleton already provides the one status region. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';

  let { bare = false }: { bare?: boolean } = $props();
  const ROWS = ['85%', '60%', '75%', '50%'];
</script>

{#snippet table()}
  <div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('foreman.office.when')}</th><th>{$t('foreman.office.mandate')}</th><th>{$t('foreman.office.action')}</th><th>{$t('foreman.office.issue')}</th><th>{$t('common.job')}</th><th>{$t('foreman.office.reason')}</th><th>{$t('foreman.office.actor')}</th></tr></thead>
      <tbody>
        {#each ROWS as reason (reason)}
          <tr>
            <td><Skeleton w="3rem" h="0.8rem" /></td>
            <td><Skeleton w="5rem" h="0.8rem" /></td>
            <td><Skeleton w="4.5rem" h="1.25rem" /></td>
            <td><Skeleton w="2.5rem" h="0.8rem" /></td>
            <td><Skeleton w="4rem" h="0.8rem" /></td>
            <td class="min-w-[12rem]"><Skeleton w={reason} h="0.8rem" /></td>
            <td><Skeleton w="3.5rem" h="0.8rem" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#if bare}<div class="plate flat">{@render table()}</div>{:else}<Loading class="plate flat">{@render table()}</Loading>{/if}
