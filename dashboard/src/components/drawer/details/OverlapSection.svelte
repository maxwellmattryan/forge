<!-- The drawer's Overlaps with card, below Dependencies: the job's last `forge overlap` report, its timing with refs, when it
     was checked, and one row per job, PR or push that shares files with it; nothing without counterparts. Refs and paths
     can come from a fork PR's author, so they render as text and a PR links out only through safeUrl. -->
<script lang="ts">
  import Chip from '../../ui/Chip.svelte';
  import { overlapRows, timingTone } from '../../../lib/jobs/overlap.ts';
  import { openDrawer } from '../../../lib/core/app.svelte.ts';
  import { ago } from '../../../lib/core/util.ts';
  import type { OverlapReport } from '../../../lib/core/types.ts';
  import { safeUrl } from '../../../lib/text/markdown.ts';
  import { t } from '../../../lib/text/locale.ts';

  let { report }: { report: OverlapReport | null | undefined } = $props();
  const rows = $derived(overlapRows(report));
  const refs = $derived(Array.isArray(report?.timing?.refs) ? report.timing.refs.filter((r) => typeof r === 'string') : []);
</script>

{#if report && rows.length}
  <div class="plate p-4 flex flex-col gap-2.5">
    <div class="flex items-center justify-between gap-2"><h3 class="h section">{$t('overlap.title')}</h3><span class="label">{$t('overlap.checked', { ago: ago(report.checkedAt) })}</span></div>
    <div class="flex items-start gap-2"><div class="label w-20 shrink-0 pt-1">{$t('overlap.timing')}</div><div class="flex flex-wrap items-center gap-2 min-w-0"><Chip tone={timingTone(report.timing?.kind)} text={String(report.timing?.kind ?? '')} />{#each refs as r, i (i)}<span class="font-mono text-[12px] break-all">{r}</span>{/each}</div></div>
    {#each rows as row, i (i)}
      <div class="flex items-start gap-2">
        <div class="label w-20 shrink-0 pt-2">{#if row.kind === 'job'}{$t('overlap.kindJob')}{:else if row.kind === 'pr'}{$t('overlap.kindPr')}{:else}{$t('overlap.kindPush')}{/if}</div>
        <div class="flex flex-col gap-1 min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            {#if row.target && 'drawer' in row.target}{@const id = row.target.drawer}<button class="btn sm normal-case tracking-normal font-mono" onclick={() => openDrawer(id)}>{row.ref}</button>{:else if row.target && 'href' in row.target}{@const href = safeUrl(row.target.href)}<a class="btn sm normal-case tracking-normal font-mono" href={href} target="_blank" rel="noopener noreferrer">{row.ref}</a>{:else}<span class="font-mono text-[12px] break-all">{row.ref}</span>{/if}
            {#if row.person}<Chip tone="you" text={$t('overlap.person')} title={$t('overlap.personHint')} />{/if}
            <span class="label">{#if row.fileMap}{$t('overlap.fileMap')}{:else}{$t('overlap.hunks', { count: row.hunks })}{/if}</span>
          </div>
          <div class="font-mono text-[11px] text-muted break-all">{row.files.join(', ')}{#if row.more}<span class="ml-1">{$t('overlap.more', { count: row.more })}</span>{/if}</div>
        </div>
      </div>
    {/each}
  </div>
{/if}
