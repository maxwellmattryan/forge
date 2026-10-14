<!-- The job drawer and its backdrop. It renders the drawerView snapshot, so it changes only where the old renderDrawer() ran. -->
<script lang="ts">
  import ActionDock from './ActionDock.svelte';
  import CommandTrigger from './CommandTrigger.svelte';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import DepSection from './DepSection.svelte';
  import Icon from './Icon.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import PrChip from './PrChip.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import StateChip from './StateChip.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import { budgetPanel } from '../lib/budget.ts';
  import { STAGE_LABEL } from '../lib/labels.ts';
  import { md, safeUrl } from '../lib/markdown.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { screenshotsPanel } from '../lib/screenshots.ts';
  import { threadOpening } from '../lib/thread.ts';
  import { ago, dur, num, tokensShort, usd } from '../lib/util.ts';
  import { eventDetail, verdictMatrix } from '../lib/view.ts';
  import { scopeVerbs } from '../lib/command.ts';
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
  const TABS = ['files', 'timeline', 'thread'];
  let tabStrip = $state<HTMLDivElement>();
  let scrolledFor: string | null = null;
  // Opened on the Thread (a session chip, a new job): bring it into view instead of leaving it below the fold.
  $effect(() => {
    const id = job?.id ?? null;
    if (!id || shown?.tab !== 'thread' || !tabStrip || scrolledFor === id) return;
    scrolledFor = id;
    const strip = tabStrip;
    strip.scrollIntoView({ block: 'start' });
    // Again once the log's first page has rendered and made the drawer tall enough to scroll that far.
    // No cleanup: a drawer refresh re-runs this effect, and must not cancel the second scroll.
    setTimeout(() => S.drawer.id === id && S.drawer.tab === 'thread' && strip.scrollIntoView({ block: 'start' }), 500);
  });
</script>

{#snippet fact(k: string, v: unknown)}
  <div><div class="label">{k}</div><div class="mono break-all">{v}</div></div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop, as on main; Escape closes the drawer from the keyboard) -->
<div id="drawer-backdrop" class="fixed inset-0 backdrop {open ? '' : 'hidden'} z-30" onclick={closeDrawer}></div>
<!-- A full-height column: the body scrolls, and the action dock under it stays put on every tab. -->
<aside id="drawer" class="fixed right-0 top-0 h-dvh flex flex-col w-full max-w-(--size-drawer-max) solid border-l border-line z-40 {open ? 'shadow-(--shadow-drawer)' : 'translate-x-full'} transition-transform">
  {#if view && 'error' in view}
    <div class="min-h-0 flex-1 overflow-y-auto p-6"><Banner msg={view.error} /></div>
  {:else if shown && job}
    {@const d = shown.detail}
    {@const j = job}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="p-5 md:p-6 flex flex-col gap-5">
        <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="h sheet-title">{j.title}</h2><div class="mono muted">{j.id}</div></div><div class="flex shrink-0 items-center gap-2">{#if scopeVerbs(j).length}<CommandTrigger variant="drawer" job={j.id} />{/if}<button class="btn icon shrink-0" aria-label={$t('drawer.close')} onclick={closeDrawer}><Icon name="close" /></button></div></div>
        <div class="flex flex-wrap gap-1.5"><span class="chip ink">{STAGE_LABEL[j.stage] ?? j.stage}</span><StateChip job={j} />{#if j.round}<Chip tone="muted" text={$t('job.round', { round: j.round, max: j.maxRounds })} />{/if}<PrChip pr={j.pr} />{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}</div>
        {#if j.reason}<div class="text-sm text-muted">{j.reason}</div>{/if}
        <ProgressBar progress={j.progress} />
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          {@render fact($t('drawer.branch'), j.branch ?? '—')}{@render fact($t('drawer.base'), j.base ?? '—')}{@render fact($t('drawer.port'), j.port ?? '—')}{@render fact($t('drawer.worktree'), j.worktree ?? '—')}
          <div><div class="label">{$t('drawer.pr')}</div><div class="mono break-all">{#if prUrl}<a class="text-ink" href={prUrl} target="_blank" rel="noopener">#{j.pr?.number}</a>{:else}—{/if}</div></div>
          <div><div class="label">{$t('drawer.source')}</div><div class="mono break-all">{#if srcUrl}<a class="text-ink" href={srcUrl} target="_blank" rel="noopener">{j.source?.ref ?? $t('drawer.link')}</a>{:else}{j.source?.ref ?? '—'}{/if}</div></div>
          {@render fact($t('drawer.session'), j.owner?.session ?? '—')}{@render fact($t('drawer.created'), ago(j.createdAt))}{@render fact($t('drawer.updated'), ago(j.updatedAt))}
        </div>
        <DepSection job={j} />
        {#if matrix}
          <div class="sheet ticks"><span class="tk"></span><div class="overflow-x-auto">
            <table class="tbl">
              <thead><tr><th>{$t('table.round')}</th><th>{$t('drawer.verify')}</th>{#each matrix.reviewers as r (r)}<th>{r}</th>{/each}</tr></thead>
              <tbody>
                {#each matrix.rounds as r (r)}
                  {@const verify = j.verify?.[r]}
                  <tr>
                    <td class="num">{r}</td>
                    <td>{#if verify}<Chip tone={verify === 'PASS' ? 'ok' : 'bad'} text={verify} />{:else}—{/if}</td>{#each matrix.reviewers as name (name)}{@const v = j.verdicts?.[r]?.[name]}<td>{#if v}<Chip tone={v === 'PASS' ? 'ok' : 'bad'} text={v} />{:else}—{/if}</td>{/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div></div>
        {/if}
        {@html budgetPanel(j, S.data?.config?.pipeline?.budget)}
        {#if usageRows.length}
          <div class="sheet ticks"><span class="tk"></span><div class="overflow-x-auto">
            <table class="tbl">
              <thead><tr><th>{$t('drawer.agent')}</th><th>{$t('common.runs')}</th><th class="r">{$t('common.tokens')}</th><th class="r">{$t('drawer.output')}</th><th class="r">{$t('drawer.tools')}</th><th class="r">{$t('drawer.time')}</th><th class="r">{$t('common.estCost')}</th></tr></thead>
              <tbody>
                {#each usageRows as [k, v] (k)}
                  <tr>
                    <td>{k}</td>
                    <td class="num">{v.runs}</td>
                    <td class="r num">{num(v.tokens)}</td>
                    <td class="r num">{v.output ? num(v.output) : '—'}</td>
                    <td class="r num">{num(v.toolUses)}</td>
                    <td class="r num">{dur(v.durationMs)}</td>
                    <td class="r num">{usd(v.estCostUsd)}</td>
                  </tr>
                {/each}
                <tr class="font-medium">
                  <td>{$t('drawer.total')}</td>
                  <td></td>
                  <td class="r num">{num(j.usage.totalTokens)}</td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td class="r num">{usd(j.usage.estCostUsd)}</td>
                </tr>
              </tbody>
            </table>
          </div></div>
        {/if}
        {@html screenshotsPanel(j.id, d.screenshots ?? [])}
        <div bind:this={tabStrip} class="tabs">{#each TABS as tab (tab)}<button class="tab {shown.tab === tab ? 'active' : ''}" aria-pressed={shown.tab === tab ? 'true' : 'false'} onclick={() => setDrawerTab(tab)}>{#if tab === 'timeline'}{$t('drawer.timeline')} <span class="muted">{d.events.length}</span>{:else if tab === 'thread'}{$t('drawer.threadTab')}{:else}{$t('drawer.files')}{/if}</button>{/each}</div>
        {#if shown.tab === 'files'}
          {@const file = shown.file}
          {@const content = shown.content}
          <div class="grid md:grid-cols-[180px_1fr] gap-4">
            <div class="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">{#each d.files as f (f)}<button class="block w-full text-left truncate px-2 py-1 text-xs font-mono {file === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}" onclick={() => loadFile(f)}>{f}</button>{/each}</div>
            <div class="min-w-0">
              {#if file && content}
                {#if 'html' in content}
                  <!-- svelte-ignore a11y_missing_attribute (no title, as on main: the iframe sits under the file list that names it) -->
                  <iframe sandbox="allow-scripts" class="w-full h-[70vh] border border-line bg-white" src="/api/jobs/{encodeURIComponent(j.id)}/raw?path={encodeURIComponent(file)}"></iframe>
                {:else if file.endsWith('.md')}
                  <div class="flex justify-end mb-2"><MarkdownToggle surface="files" /></div>
                  {#if mdView.files === 'rendered'}
                    <div class="prose">{@html md(content.text)}</div>
                  {:else}
                    <pre class="text-[12px] font-mono whitespace-pre-wrap break-words bg-raised p-3">{content.text}</pre>
                  {/if}
                {:else}
                  <pre class="text-[12px] font-mono whitespace-pre-wrap break-words bg-raised p-3">{content.text}</pre>
                {/if}
              {:else}
                <div class="text-sm text-muted">{$t('drawer.noFiles')}</div>
              {/if}
            </div>
          </div>
        {:else if shown.tab === 'thread'}
          <ThreadPanel job={j} requests={d.requests ?? []} opening={threadOpening(d)} active={open} />
        {:else}
          <ul>
            {#each events as e, i (i)}
              {@const x = eventDetail(e, { tokens: tokensShort, dur })}
              <li class="flex gap-3 py-1.5 border-b border-line text-xs"><span class="text-muted whitespace-nowrap w-16 shrink-0">{ago(e.ts)}</span><span class="font-mono text-ink shrink-0 w-28 truncate">{e.type}</span><span class="min-w-0 break-words">{x.pre}{#if x.bold !== null}<b>{x.bold}</b>{/if}{x.post}</span></li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
    <ActionDock job={j} />
  {/if}
</aside>
