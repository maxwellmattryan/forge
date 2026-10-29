<!-- The Machine view's projects table while the machine summary loads: the real column headers over three bone rows. -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';
</script>

<Loading class="overflow-x-auto">
  <table class="tbl">
    <thead><tr><th>{$t('machine.name')}</th><th>{$t('machine.path')}</th><th>{$t('machine.status')}</th></tr></thead>
    <tbody>
      {#each [['6rem', '70%', '4rem'], ['8rem', '55%', '4rem'], ['5rem', '80%', '5.5rem']] as [name, path, status] (name)}
        <tr>
          <td><Skeleton w={name} h="1.25rem" /></td>
          <td class="max-w-[32rem]"><Skeleton w={path} h="1rem" /></td>
          <td><Skeleton w={status} h="1.25rem" round /></td>
        </tr>
      {/each}
    </tbody>
  </table>
</Loading>
