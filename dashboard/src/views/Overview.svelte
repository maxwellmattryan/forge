<!-- Overview: the machine's registered projects, one row each, from GET /api/projects (S.machine). An openable project's
     name links to its Pipeline; a missing or unavailable one is plain text with its chip. #402 adds the graphs and cards. -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Chip from '../components/Chip.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { S } from '../lib/app.svelte.ts';
  import { switcherEntries } from '../lib/switcher.ts';
  import { t } from '../lib/locale.ts';

  const entries = $derived(switcherEntries(S.machine));
</script>

<PageHeader title={$t('overview.title')}>
  {#snippet sub()}{$t('overview.sub')}{/snippet}
</PageHeader>
{#if S.machineLost}<Banner msg={S.machineLost} />{/if}
{#if S.machine?.error}<Banner msg={$t('overview.indexError', { error: S.machine.error })} />{/if}
{#if !S.machine}
  {#if S.machineOnline !== false}<div class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</div>{/if}
{:else if !entries.length}
  <Empty>{$t('overview.empty')}</Empty>
{:else}
  <div class="plate flat"><div class="label callout px-3 pt-3">{$t('overview.projects')}</div><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('overview.project')}</th><th>{$t('overview.path')}</th><th class="r">{$t('overview.active')}</th><th class="r">{$t('overview.waiting')}</th><th class="r">{$t('overview.sessions')}</th></tr></thead>
      <tbody>
        {#each entries as e (e.name)}
          <tr>
            <td class="whitespace-nowrap">
              {#if e.openable}<a class="font-mono text-fg underline-offset-2 hover:underline" href="#/p/{e.name}/pipeline">{e.name}</a>
              {:else}<span class="font-mono text-muted">{e.name}</span> <Chip tone={e.state === 'missing' ? 'warn' : 'muted'} extra="ml-1.5" text={e.state === 'missing' ? $t('switcher.missing') : $t('switcher.unavailable')} />{/if}
            </td>
            <td class="max-w-[28rem]"><span class="block truncate font-mono text-xs text-muted" title={e.path}>{e.path}</span></td>
            <td class="r num">{e.openable ? e.active : ''}</td>
            <td class="r num">{#if e.openable && e.waiting}<Chip tone="you" text={e.waiting} />{:else if e.openable}0{/if}</td>
            <td class="r num font-mono text-xs">{e.daemon ? `${e.daemon.live}/${e.daemon.maxConcurrent}` : ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{/if}
