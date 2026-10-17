<!-- The drawer's Repos table for a job with member repos: one row per job repo, root first. Nothing for a single-repo job. -->
<script lang="ts">
  import PrChip from './PrChip.svelte';
  import { jobRepoRows } from '../lib/repos.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { S } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Partial<Job> } = $props();
  const rows = $derived(jobRepoRows(job, S.data?.repo?.name ?? ''));
</script>

{#if rows.length}
  <div class="plate flat">
    <h3 class="h section px-4 pt-3">{$t('drawer.repos')}</h3>
    <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('drawer.repo')}</th><th>{$t('drawer.branch')}</th><th>{$t('drawer.base')}</th><th>{$t('drawer.worktree')}</th><th>{$t('drawer.pr')}</th></tr></thead>
        <tbody>
          {#each rows as row, i (i)}
            {@const href = safeUrl(row.prUrl)}
            <tr>
              <td class="mono">{row.name}</td>
              <td class="mono break-all">{#if row.verifyOnly}<span class="muted">{$t('drawer.verifyOnly')}</span>{:else}{row.branch ?? '—'}{/if}</td>
              <td class="mono">{row.base ?? '—'}</td>
              <td class="mono break-all selectable">{row.worktree ?? '—'}</td>
              <td class="whitespace-nowrap">{#if href}<a {href} target="_blank" rel="noopener"><PrChip pr={row.pr} /></a>{:else if row.prNumber}<PrChip pr={row.pr} />{:else}—{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}
