<!-- The drawer's Repos table for a job with member repos: one row per job repo, root first. Nothing for a single-repo job. -->
<script lang="ts">
  import PrChip from '../../jobs/PrChip.svelte';
  import { jobRepoRows } from '../../../lib/jobs/repos.ts';
  import { S } from '../../../lib/core/app.svelte.ts';
  import type { Job } from '../../../lib/core/types.ts';
  import { t } from '../../../lib/text/locale.ts';

  let { job }: { job: Partial<Job> } = $props();
  const rows = $derived(jobRepoRows(job, S.data?.repo?.name ?? ''));
  const headingId = $derived(`repos-${job.id ?? ''}`);
</script>

{#if rows.length}
  <div class="plate flat">
    <h3 id={headingId} class="h section px-3 pt-3">{$t('drawer.repos')}</h3>
    <!-- Minimum widths, so at phone width the table scrolls as a whole instead of crushing its cells into fragments. -->
    <div class="overflow-x-auto">
      <table class="tbl min-w-[36rem]" aria-labelledby={headingId}>
        <thead><tr><th>{$t('drawer.repo')}</th><th>{$t('drawer.branch')}</th><th>{$t('drawer.base')}</th><th>{$t('drawer.worktree')}</th><th>{$t('drawer.pr')}</th></tr></thead>
        <tbody>
          {#each rows as row, i (i)}
            <tr>
              <td class="mono">{row.name}</td>
              <td class="mono whitespace-nowrap">{#if row.verifyOnly}<span class="muted">{$t('drawer.verifyOnly')}</span>{:else}{row.branch ?? '—'}{/if}</td>
              <td class="mono">{row.base ?? '—'}</td>
              <td class="mono break-all min-w-[16rem] selectable">{row.worktree ?? '—'}</td>
              <td class="whitespace-nowrap">{#if row.prNumber}<PrChip pr={row.pr} />{:else}—{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}
