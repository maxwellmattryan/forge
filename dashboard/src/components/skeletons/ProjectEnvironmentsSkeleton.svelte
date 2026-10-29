<!-- The Project view's environments table while GET /api/environments loads: the real column headers, a few bone rows.
     Content only: the caller supplies the <Loading> root. -->
<script lang="ts">
  import Skeleton from '../Skeleton.svelte';
  import { t } from '../../lib/text/locale.ts';

  const rows = [
    { job: '70%', port: '3rem' },
    { job: '55%', port: '3rem' },
    { job: '65%', port: '3rem' },
  ];
</script>

<div class="plate flat"><div class="overflow-x-auto">
  <table class="tbl" aria-hidden="true">
    <thead>
      <tr>
        <th>{$t('project.environments.table.job')}</th>
        <th>{$t('project.environments.table.state')}</th>
        <th>{$t('project.environments.table.devPort')}</th>
        <th class="text-right">{$t('project.environments.table.devCpu')}</th>
        <th class="text-right">{$t('project.environments.table.devMem')}</th>
        <th class="text-right">{$t('project.environments.table.containers')}</th>
        <th class="text-right">{$t('project.environments.table.cpu')}</th>
        <th class="text-right">{$t('project.environments.table.mem')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r, i (i)}
        <tr>
          <td><Skeleton w={r.job} h="0.8rem" /></td>
          <td><Skeleton w="4.5rem" h="1.25rem" /></td>
          <td><Skeleton w={r.port} h="0.75rem" /></td>
          <td><Skeleton w="2.5rem" h="0.75rem" class="ml-auto" /></td>
          <td><Skeleton w="3rem" h="0.75rem" class="ml-auto" /></td>
          <td><Skeleton w="1.5rem" h="0.75rem" class="ml-auto" /></td>
          <td><Skeleton w="2.5rem" h="0.75rem" class="ml-auto" /></td>
          <td><Skeleton w="3rem" h="0.75rem" class="ml-auto" /></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div></div>
