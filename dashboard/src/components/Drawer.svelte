<!-- The job drawer and its backdrop. It renders the drawerView snapshot, so it changes only where the old renderDrawer() ran. -->
<script lang="ts">
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import DepSection from './DepSection.svelte';
  import Icon from './Icon.svelte';
  import PrChip from './PrChip.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import SessionLog from './SessionLog.svelte';
  import StateChip from './StateChip.svelte';
  import { budgetPanel } from '../lib/budget.ts';
  import { STAGE_LABEL } from '../lib/labels.ts';
  import { md, safeUrl } from '../lib/markdown.ts';
  import { screenshotsPanel } from '../lib/screenshots.ts';
  import { ago, dur, num, tokensShort, usd } from '../lib/util.ts';
  import { eventDetail, verdictMatrix } from '../lib/view.ts';
  import { S, closeDrawer, loadFile, setDrawerTab } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  const open = $derived(S.drawer.id !== null);
  const view = $derived(S.drawerView);
  const shown = $derived(view && 'detail' in view ? view : null);
  const job = $derived(shown?.detail.job);
  const prUrl = $derived(safeUrl(job?.pr?.url));
  const srcUrl = $derived(safeUrl(job?.source?.url));
  const matrix = $derived(job ? verdictMatrix(job) : null);
  const usageRows = $derived(Object.entries(job?.usage?.byRole ?? {}));
  const events = $derived(shown ? shown.detail.events.slice().reverse() : []);
  const TABS = ['files', 'timeline', 'session'];
</script>

{#snippet fact(k: string, v: unknown)}
  <div><div class="text-[11px] text-muted">{k}</div><div class="text-sm font-mono break-all">{v}</div></div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop, as on main; Escape closes the drawer from the keyboard) -->
<div id="drawer-backdrop" class="fixed inset-0 bg-black/40 {open ? '' : 'hidden'} z-30" onclick={closeDrawer}></div>
<aside id="drawer" class="fixed right-0 top-0 h-full w-full max-w-3xl bg-bg border-l border-line z-40 {open ? '' : 'translate-x-full'} transition-transform overflow-y-auto">
  {#if view && 'error' in view}
    <div class="p-6"><Banner msg={view.error} /></div>
  {:else if shown && job}
    {@const d = shown.detail}
    {@const j = job}
    <div class="p-5 md:p-6 flex flex-col gap-5">
      <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-lg font-semibold">{j.title}</h2><div class="text-xs text-muted font-mono">{j.id}</div></div><button class="btn" onclick={closeDrawer}><Icon name="close" /></button></div>
      <div class="flex flex-wrap gap-1.5"><Chip tone="muted" text={STAGE_LABEL[j.stage] ?? j.stage} /><StateChip job={j} />{#if j.round}<Chip tone="muted" text={$t('job.round', { round: j.round, max: j.maxRounds })} />{/if}<PrChip pr={j.pr} />{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}</div>
      {#if j.reason}<div class="text-sm text-muted">{j.reason}</div>{/if}
      <ProgressBar progress={j.progress} />
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        {@render fact($t('drawer.branch'), j.branch ?? '—')}{@render fact($t('drawer.base'), j.base ?? '—')}{@render fact($t('drawer.port'), j.port ?? '—')}{@render fact($t('drawer.worktree'), j.worktree ?? '—')}
        <div><div class="text-[11px] text-muted">{$t('drawer.pr')}</div><div class="text-sm font-mono break-all">{#if prUrl}<a class="text-accent" href={prUrl} target="_blank" rel="noopener">#{j.pr?.number}</a>{:else}—{/if}</div></div>
        <div><div class="text-[11px] text-muted">{$t('drawer.source')}</div><div class="text-sm font-mono break-all">{#if srcUrl}<a class="text-accent" href={srcUrl} target="_blank" rel="noopener">{j.source?.ref ?? $t('drawer.link')}</a>{:else}{j.source?.ref ?? '—'}{/if}</div></div>
        {@render fact($t('drawer.session'), j.owner?.session ?? '—')}{@render fact($t('drawer.created'), ago(j.createdAt))}{@render fact($t('drawer.updated'), ago(j.updatedAt))}
      </div>
      <DepSection job={j} />
      {#if matrix}
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>{$t('table.round')}</th><th>{$t('drawer.verify')}</th>{#each matrix.reviewers as r (r)}<th>{r}</th>{/each}</tr></thead>
            <tbody>
              {#each matrix.rounds as r (r)}
                {@const verify = j.verify?.[r]}
                <tr>
                  <td class="tabular-nums">{r}</td>
                  <td>{#if verify}<Chip tone={verify === 'PASS' ? 'ok' : 'bad'} text={verify} />{:else}—{/if}</td>{#each matrix.reviewers as name (name)}{@const v = j.verdicts?.[r]?.[name]}<td>{#if v}<Chip tone={v === 'PASS' ? 'ok' : 'bad'} text={v} />{:else}—{/if}</td>{/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {@html budgetPanel(j, S.data?.config?.pipeline?.budget)}
      {#if usageRows.length}
        <div class="card overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>{$t('drawer.agent')}</th><th>{$t('common.runs')}</th><th class="text-right">{$t('common.tokens')}</th><th class="text-right">{$t('drawer.output')}</th><th class="text-right">{$t('drawer.tools')}</th><th class="text-right">{$t('drawer.time')}</th><th class="text-right">{$t('common.estCost')}</th></tr></thead>
            <tbody>
              {#each usageRows as [k, v] (k)}
                <tr>
                  <td>{k}</td>
                  <td class="tabular-nums">{v.runs}</td>
                  <td class="text-right tabular-nums">{num(v.tokens)}</td>
                  <td class="text-right tabular-nums">{v.output ? num(v.output) : '—'}</td>
                  <td class="text-right tabular-nums">{num(v.toolUses)}</td>
                  <td class="text-right tabular-nums">{dur(v.durationMs)}</td>
                  <td class="text-right tabular-nums">{usd(v.estCostUsd)}</td>
                </tr>
              {/each}
              <tr class="font-medium">
                <td>{$t('drawer.total')}</td>
                <td></td>
                <td class="text-right tabular-nums">{num(j.usage.totalTokens)}</td>
                <td></td>
                <td></td>
                <td></td>
                <td class="text-right tabular-nums">{usd(j.usage.estCostUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      {/if}
      {@html screenshotsPanel(j.id, d.screenshots ?? [])}
      <div class="flex gap-1 border-b border-line">{#each TABS as tab (tab)}<button class="px-3 py-2 text-sm -mb-px border-b-2 {shown.tab === tab ? 'border-accent text-fg' : 'border-transparent text-muted'}" onclick={() => setDrawerTab(tab)}>{#if tab === 'timeline'}{$t('drawer.timeline')} <span class="text-muted">{d.events.length}</span>{:else if tab === 'session'}{$t('drawer.sessionTab')}{:else}{$t('drawer.files')}{/if}</button>{/each}</div>
      {#if shown.tab === 'files'}
        {@const file = shown.file}
        {@const content = shown.content}
        <div class="grid md:grid-cols-[180px_1fr] gap-4">
          <div class="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">{#each d.files as f (f)}<button class="block w-full text-left truncate rounded px-2 py-1 text-xs font-mono {file === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}" onclick={() => loadFile(f)}>{f}</button>{/each}</div>
          <div class="min-w-0">
            {#if file && content}
              {#if 'html' in content}
                <!-- svelte-ignore a11y_missing_attribute (no title, as on main: the iframe sits under the file list that names it) -->
                <iframe sandbox="allow-scripts" class="w-full h-[70vh] rounded-lg border border-line bg-white" src="/api/jobs/{encodeURIComponent(j.id)}/raw?path={encodeURIComponent(file)}"></iframe>
              {:else if file.endsWith('.md')}
                <div class="prose-md">{@html md(content.text)}</div>
              {:else}
                <pre class="text-[12px] font-mono whitespace-pre-wrap break-words bg-raised rounded-lg p-3">{content.text}</pre>
              {/if}
            {:else}
              <div class="text-sm text-muted">{$t('drawer.noFiles')}</div>
            {/if}
          </div>
        </div>
      {:else if shown.tab === 'session'}
        <!-- Keyed by job id only, so the drawer's 2 s refresh never re-creates the log or its stream; `active` closes the
             stream as soon as the drawer closes, though its last view stays while it slides out. -->
        {#key j.id}<SessionLog scope={j.id} active={open} />{/key}
      {:else}
        <ul>
          {#each events as e, i (i)}
            {@const x = eventDetail(e, { tokens: tokensShort, dur })}
            <li class="flex gap-3 py-1.5 border-b border-line text-xs"><span class="text-muted whitespace-nowrap w-16 shrink-0">{ago(e.ts)}</span><span class="font-mono text-accent shrink-0 w-28 truncate">{e.type}</span><span class="min-w-0 break-words">{x.pre}{#if x.bold !== null}<b>{x.bold}</b>{/if}{x.post}</span></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</aside>
