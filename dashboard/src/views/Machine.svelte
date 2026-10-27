<!-- Machine: this machine's dashboard address, its machine cap and its registered projects, from GET /api/projects
     (S.machine). Read-only: each section names the CLI command that changes it. -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Chip from '../components/Chip.svelte';
  import Empty from '../components/Empty.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import MachineCapSkeleton from '../components/skeletons/MachineCapSkeleton.svelte';
  import MachineProjectsSkeleton from '../components/skeletons/MachineProjectsSkeleton.svelte';
  import { S } from '../lib/app.svelte.ts';
  import type { MachineProjectSummary } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  const m = $derived(S.machine);
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  const statusLabel = $derived<Record<MachineProjectSummary['status'], string>>({
    ok: $t('machine.statusOk'),
    missing: $t('machine.statusMissing'),
    'not-initialized': $t('machine.statusNotInitialized'),
  });
  const statusTone = (s: MachineProjectSummary['status']): string => (s === 'ok' ? 'ok' : s === 'missing' ? 'warn' : 'muted');
</script>

{#snippet fact(label: string, value: string | number)}
  <div class="flex flex-col gap-0.5"><dt class="label">{label}</dt><dd class="font-mono text-sm text-fg break-words">{value}</dd></div>
{/snippet}

{#snippet command(cmd: string)}
  <p class="mt-3 flex flex-wrap items-baseline gap-2 text-xs text-muted">{$t('machine.change')}<code class="font-mono text-fg selectable">{cmd}</code></p>
{/snippet}

<PageHeader title={$t('machine.title')}>
  {#snippet sub()}{$t('machine.sub')}{/snippet}
</PageHeader>
{#if S.machineLost}<Banner msg={S.machineLost} />{/if}
{#if m?.error}<Banner msg={$t('overview.indexError', { error: m.error })} />{/if}
<div class="grid gap-4 md:grid-cols-2 mb-4">
  <section class="plate p-4" aria-labelledby="machine-dashboard">
    <h2 id="machine-dashboard" class="label callout mb-3">{$t('machine.dashboard')}</h2>
    <dl class="grid gap-3 sm:grid-cols-2">{@render fact($t('machine.origin'), location.origin)}{@render fact($t('machine.port'), port)}</dl>
  </section>
  <section class="plate p-4" aria-labelledby="machine-cap">
    <h2 id="machine-cap" class="label callout mb-3">{$t('machine.cap')}</h2>
    {#if m}
      <dl class="grid gap-3 sm:grid-cols-3">
        {@render fact($t('machine.capValue'), m.machine.maxConcurrent)}
        {@render fact($t('machine.live'), m.machine.live)}
        {@render fact($t('machine.source'), m.machine.source === 'auto' ? $t('machine.sourceAuto') : $t('machine.sourceSettings'))}
      </dl>
    {:else if S.machineOnline !== false}<MachineCapSkeleton />{/if}
    {@render command($t('machine.capCommand'))}
  </section>
</div>
<section class="plate flat" aria-labelledby="machine-projects">
  <h2 id="machine-projects" class="label callout px-3 pt-3">{$t('machine.projects')}</h2>
  {#if !m}
    {#if S.machineOnline !== false}<MachineProjectsSkeleton />{/if}
  {:else if !m.projects.length}
    <div class="p-3"><Empty>{$t('overview.empty')}</Empty></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('machine.name')}</th><th>{$t('machine.path')}</th><th>{$t('machine.status')}</th></tr></thead>
        <tbody>
          {#each m.projects as p (p.name)}
            <tr>
              <td class="font-mono whitespace-nowrap">{p.name}</td>
              <td class="max-w-[32rem]"><span class="block truncate font-mono text-xs text-muted selectable" title={p.path}>{p.path}</span></td>
              <td><Chip tone={statusTone(p.status)} text={statusLabel[p.status]} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <div class="px-3 pb-3">{@render command($t('machine.addCommand'))}{@render command($t('machine.removeCommand'))}</div>
</section>
