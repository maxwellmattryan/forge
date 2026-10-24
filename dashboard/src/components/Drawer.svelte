<!-- The job drawer: it slides in from the right over a backdrop, over the whole viewport height (the status bar included), and
     the view keeps its centred width underneath. It renders the drawerView snapshot, so it changes only where the old
     renderDrawer() ran. At md and up its width is the viewer's (pref paneWidth, one for every job), clamped so it never
     covers the sidebar column, and the separator on its left edge resizes it; below md it is full width. The backdrop,
     Escape or the close button closes it; closed, it is invisible, so out of the tab order. Its header is four rows: the
     title with the close button, the meta line (id · round) with one right-aligned controls cluster, one badge row, and
     the live agent line while agents run. Every row wraps, so it never scrolls sideways at any width. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import ActionDock from './ActionDock.svelte';
  import AgentActivity from './AgentActivity.svelte';
  import AgentsTab from './AgentsTab.svelte';
  import CloseButton from './CloseButton.svelte';
  import CommandTrigger from './CommandTrigger.svelte';
  import Banner from './Banner.svelte';
  import BudgetPanel from './BudgetPanel.svelte';
  import Chip from './Chip.svelte';
  import DeleteJobSection from './DeleteJobSection.svelte';
  import DepSection from './DepSection.svelte';
  import EffortChip from './EffortChip.svelte';
  import EnvironmentSection from './EnvironmentSection.svelte';
  import LeaseChip from './LeaseChip.svelte';
  import LiveDot from './LiveDot.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import MergeNowSection from './MergeNowSection.svelte';
  import PrChip from './PrChip.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import RepoSection from './RepoSection.svelte';
  import ScreenshotsPanel from './ScreenshotsPanel.svelte';
  import SessionActivity from './SessionActivity.svelte';
  import SessionControls from './SessionControls.svelte';
  import SessionLog from './SessionLog.svelte';
  import SessionToggle from './SessionToggle.svelte';
  import StateChip from './StateChip.svelte';
  import ThreadLive from './ThreadLive.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '../lib/icons.ts';
  import { effortChip } from '../lib/effort.ts';
  import { protectedSummary } from '../lib/protected.ts';
  import { mergeNowOffered } from '../lib/merge-now.ts';
  import { STAGE_LABEL } from '../lib/labels.ts';
  import { md, safeUrl } from '../lib/markdown.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { threadItems, threadMarks, threadOpening, unreadCount } from '../lib/thread.ts';
  import { ago, dur, num, tokensShort, usd } from '../lib/util.ts';
  import { scopeVerbs } from '../lib/command.ts';
  import { S, closeDrawer, loadFile, setDrawerTab } from '../lib/app.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { freshCount, sessionActivity } from '../lib/live.ts';
  import { t } from '../lib/locale.ts';
  import { DRAWER_TABS, PANE_DEFAULT, PANE_MIN, actorLabel, clampPaneWidth, eventDetail, isForemanEvent, moveDrawerTab, paneKey, paneMax, verdictMatrix, verifierRounds, verifierTone, type DrawerTab } from '../lib/drawer.ts';
  import { pref } from '../lib/prefs.ts';
  import { slideMarker } from '../lib/marker.ts';
  import { sidebarShown } from '../lib/sidebar.ts';

  const open = $derived(S.drawer.id !== null);
  const view = $derived(S.drawerView);
  const shown = $derived(view && 'detail' in view ? view : null);
  const job = $derived(shown?.detail.job);
  const prUrl = $derived(safeUrl(job?.pr?.url));
  // Only a job with a verifiers record gets the column. The detail's events are the last 400
  // (lib/server/routes/jobs.ts), so on a very long job an early round's cell can read — though it ran.
  const verifierResults = $derived(shown ? verifierRounds(shown.detail.events) : {});
  const hasVerifiers = $derived(Object.keys(verifierResults).length > 0);
  const matrix = $derived(job ? verdictMatrix(job, verifierResults) : null);
  const effort = $derived(job ? effortChip(job.effort, S.data?.config?.effort) : null);
  const prot = $derived(job ? protectedSummary(job) : null);
  const usageRows = $derived(Object.entries(job?.usage?.byRole ?? {}));
  const events = $derived(shown ? shown.detail.events.slice().reverse() : []);
  const activity = $derived(job ? sessionActivity(S.data?.daemons?.jobs?.[job.id], shown?.detail.events.at(-1)?.ts) : null);
  // Timeline rows are newest first, so the first `fresh` arrived after the drawer opened.
  const fresh = $derived(shown ? freshCount(shown.detail.events.length, S.drawer.eventsAtOpen) : 0);
  const unread = $derived(shown && job ? unreadCount(threadMarks(threadItems(shown.detail.requests ?? [], threadOpening(shown.detail), shown.detail.events ?? [])), S.threadSeen[job.id] ?? null) : 0);
  // The live activity comes with /api/state (polled every 2 s); the detail carries the round's agents.
  const stateJob = $derived(job ? (S.data?.jobs?.find((x) => x.id === job.id) ?? null) : null);
  const running = $derived(stateJob?.activity ?? []);
  // An interactive owner's transcript takes the Log tab's place of the (absent) daemon session's log.
  const ownerLog = $derived(job && shown?.detail.ownerTranscript ? { job: job.id, agent: null, label: $t('session.interactive', { session: shown.detail.ownerTranscript.session.slice(0, 8) }) } : null);
  const logKey = $derived(ownerLog && job ? `${job.id}:owner` : (job?.id ?? ''));
  let head = $state<HTMLDivElement>();
  let panel = $state<HTMLDivElement>();
  // Closing the drawer, or opening another job from inside it, starts the next view at the top. A 2 s poll keeps the
  // id, so it never moves the scroll.
  $effect(() => {
    void S.drawer.id;
    if (panel) panel.scrollTop = 0;
    if (head) head.scrollTop = 0;
  });
  /** The header and the tab strip never scroll away, so a new tab simply starts at its own top. */
  function selectTab(tab: DrawerTab, focus = false): void {
    setDrawerTab(tab);
    if (panel) panel.scrollTop = 0;
    if (focus) document.getElementById('drawer-tab-' + tab)?.focus();
  }
  // ---------- the separator ----------
  // A saved width wider than the window shows clamped; the pref keeps it, so widening the window gives it back.
  // The drawer stops at the sidebar's current edge: the rail or the viewer's width.
  const gutter = $derived(sidebarShown(S.side));
  const width = $derived(clampPaneWidth(S.pane.width, S.pane.viewport, gutter));
  let drag: { x: number; w: number } | null = null;
  let dragging = $state(false);
  const save = (): void => pref.set('paneWidth', String(S.pane.width));
  function dragStart(e: PointerEvent & { currentTarget: HTMLElement }): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, w: width };
    dragging = true;
  }
  function dragMove(e: PointerEvent): void {
    // The separator is the drawer's left edge: moving left widens it.
    if (drag) S.pane.width = clampPaneWidth(drag.w + (drag.x - e.clientX), S.pane.viewport, gutter);
  }
  // Both pointerup and lostpointercapture end a drag (capture can be lost without a pointerup); the second call finds
  // drag null and returns, so the width is saved once.
  function dragEnd(): void {
    if (!drag) return;
    drag = null;
    dragging = false;
    save();
  }
  function sepKey(e: KeyboardEvent): void {
    const next = paneKey(width, e.key, e.shiftKey, S.pane.viewport, gutter);
    if (next === null) return;
    e.preventDefault();
    S.pane.width = next;
    save();
  }
  function sepReset(): void {
    S.pane.width = clampPaneWidth(PANE_DEFAULT, S.pane.viewport, gutter);
    save();
  }

  // The drawer covers the view, which App makes inert: focus moves to the job title once it renders, unless it is already
  // in the drawer. App hands it back to the opener on close.
  let pane = $state<HTMLElement>();
  let title = $state<HTMLHeadingElement>();
  $effect(() => {
    if (!open || !title || !pane) return;
    const el = pane;
    if (!untrack(() => el.contains(document.activeElement))) title.focus();
  });

  function stripKey(e: KeyboardEvent): void {
    if (!shown) return;
    const next = moveDrawerTab(shown.tab, e.key);
    if (!next) return;
    e.preventDefault();
    selectTab(next, true);
  }
</script>

{#snippet fact(k: string, v: unknown, icon: IconName | null = null)}
  <div><div class="label">{k}</div><div class="mono text-[13px] break-all selectable">{#if icon}<Icon name={icon} class="sm mr-1 inline-block align-[-2px] text-muted" />{/if}{v}</div></div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop, as on main; Escape closes the drawer from the keyboard) -->
<!-- Always mounted, so it fades both ways: closed, it is invisible and lets presses through. -->
<div id="drawer-backdrop" class="fixed inset-0 backdrop z-30 {open ? 'opacity-100 transition-[opacity] duration-(--motion-base) ease-(--ease-enter)' : 'opacity-0 invisible pointer-events-none transition-[opacity,visibility] duration-(--motion-quick) ease-(--ease-exit)'}" onclick={closeDrawer}></div>
<!-- A full-height column that never scrolls itself: the header (capped at 40%, scrolling inside itself when taller) and
     the tab strip stay put, the tab panel under them is the one scroller (on Log, the log pane is), and the action dock
     under it stays put on every tab. It runs to the viewport's bottom, over the status bar, which the backdrop dims like
     the rest of the page; the bottom inset keeps the dock clear of a phone's home indicator. Opening slides it 24px in from
     the right as it fades in (base, easing out); closing slides and fades it out (quick, easing in); the reduced-motion
     block turns both off. Only a close transitions visibility, so it turns invisible at the end of the exit: on open it
     turns visible at once, as a transition would hold it hidden for the first frame and the title could not take focus.
     A drag drops the transition, so the width follows the pointer. -->
<aside
  bind:this={pane}
  id="drawer"
  aria-label={$t('drawer.label')}
  class="fixed right-0 top-0 bottom-0 pb-[env(safe-area-inset-bottom)] z-40 solid w-full flex flex-col overflow-hidden {open ? 'opacity-100 shadow-(--shadow-drawer)' : 'translate-x-6 opacity-0 invisible'} {dragging ? '' : open ? 'transition-[translate,opacity] duration-(--motion-base) ease-(--ease-enter)' : 'transition-[translate,opacity,visibility] duration-(--motion-quick) ease-(--ease-exit)'}"
  style={S.pane.md ? `width: ${width}px` : undefined}
>
  {#if S.pane.md && open}
    <!-- An 8px hit area over the drawer's left rule; the rule turns gleam while it is hovered, focused or dragged. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator with a value is a widget in ARIA: the window splitter pattern) -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls="drawer"
      aria-label={$t('drawer.resize')}
      aria-valuemin={PANE_MIN}
      aria-valuemax={paneMax(S.pane.viewport, gutter)}
      aria-valuenow={width}
      tabindex="0"
      class="group absolute inset-y-0 left-0 z-30 w-2 cursor-col-resize touch-none focus-visible:-outline-offset-2"
      onpointerdown={dragStart}
      onpointermove={dragMove}
      onpointerup={dragEnd}
      onlostpointercapture={dragEnd}
      onkeydown={sepKey}
      ondblclick={sepReset}
    ><span class="absolute inset-y-0 left-0 border-l {dragging ? 'border-gleam' : 'border-line group-hover:border-gleam group-focus-visible:border-gleam'}" aria-hidden="true"></span></div>
  {/if}
  {#if view && 'error' in view}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6"><Banner msg={view.error} /></div>
  {:else if shown && job}
    {@const d = shown.detail}
    {@const j = job}
    {@const verbs = scopeVerbs(j).length > 0}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div bind:this={head} class="shrink-0 max-h-[40%] overflow-y-auto overscroll-contain p-5 md:p-6 pb-3 md:pb-4 flex flex-col gap-2">
        <div class="flex items-start justify-between gap-3"><h2 bind:this={title} tabindex="-1" class="h sheet-title min-w-0">{j.title}</h2><CloseButton size="sm" label={$t('drawer.close')} onclick={closeDrawer} /></div>
        <!-- The meta line, then one right-aligned controls cluster: a daemon-backed job's session controls (here, not in its
             Log, so every tab has them; its Start/Stop sits apart, at the end of the tab row), then Command, nearest the
             close button. An interactive owner's job has no session controls, as its Log follows a transcript, and keeps
             the effort chip. ml-auto keeps the cluster right-aligned when it wraps under the meta line. -->
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><div class="mono text-[13px] muted min-w-0 break-all"><span class="selectable">{j.id}</span>{#if j.round}{' · '}<span class="whitespace-nowrap">{$t('job.round', { round: j.round, max: j.maxRounds })}</span>{/if}</div>{#if !ownerLog || verbs}<div class="ml-auto flex min-w-0 flex-wrap items-start justify-end gap-1.5">{#if !ownerLog}{#key j.id}<SessionControls scope={j.id} toggle={false} />{/key}{/if}{#if verbs}<CommandTrigger job={j.id} />{/if}</div>{/if}</div>
        <!-- One wrapping badge row: the job's chips, the lease, the session's activity, and last the reason, one truncated
             line that wraps onto its own line here when there is no room. -->
        <div class="flex min-w-0 flex-wrap items-center gap-1.5"><Chip tone="gleam" text={STAGE_LABEL[j.stage] ?? j.stage} /><StateChip job={j} />{#if prot}<Chip tone="warn" extra="max-w-full flex-wrap whitespace-normal" text={$t('job.protectedDrawer', { reasons: prot.reasons.join(' · ') })} />{/if}<PrChip pr={j.pr} />{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}{#if ownerLog}<EffortChip level={effort} />{/if}<LeaseChip owner={j.ownerStatus} />{#if activity}<SessionActivity {activity} extra="caption" />{/if}{#if j.reason}<span class="caption muted min-w-0 max-w-full truncate" title={j.reason}>{j.reason}</span>{/if}</div>
        <!-- On the Thread the live line under the conversation says what runs, so the header doesn't say it twice. -->
        {#if shown.tab !== 'thread' && running.length}<AgentActivity activity={running} expandable={true} />{/if}
      </div>
      <!-- Outside the scroller, so it never moves; the tabs scroll sideways when they outgrow a phone. A daemon-backed
           job's Start/Stop ends the row on its own, as far from the edge as the header's controls. -->
      <div class="shrink-0 z-20 solid flex">
        <div role="tablist" tabindex="-1" aria-label={$t('drawer.tabs')} {@attach slideMarker('[aria-selected="true"]', 'bar-bottom')} class="tabs slide-marker min-w-0 flex-1 pl-5 md:pl-6 overflow-x-auto overflow-y-hidden" onkeydown={stripKey}>{#each DRAWER_TABS as tab (tab)}<button role="tab" id="drawer-tab-{tab}" aria-selected={shown.tab === tab} aria-controls="drawer-panel-{tab}" tabindex={shown.tab === tab ? 0 : -1} class="tab shrink-0 whitespace-nowrap focus-visible:-outline-offset-2 {shown.tab === tab ? 'active' : ''}" onclick={() => selectTab(tab)}>{#if tab === 'thread'}{$t('drawer.threadTab')}{#if unread > 0}<Chip extra="spark ml-1.5" text={$t('drawer.threadUnread', { count: unread })} />{/if}{:else if tab === 'log'}{$t('drawer.logTab')}{#if activity?.kind === 'working'}<span class="inline-flex ml-1.5 align-middle"><LiveDot on={true} /></span><span class="sr-only">{$t('live.working')}</span>{/if}{:else if tab === 'agents'}{$t('drawer.agentsTab')}{#if running.length}<span class="muted num ml-1">({running.length})</span>{/if}{:else if tab === 'files'}{$t('drawer.files')}{:else if tab === 'timeline'}{$t('drawer.timeline')} <span class="muted num">({d.events.length})</span>{:else if tab === 'details'}{$t('drawer.detailsTab')}{/if}</button>{/each}</div>
        {#if !ownerLog}<div class="flex shrink-0 items-center border-b border-line pl-3 pr-5 md:pr-6">{#key j.id}<SessionToggle scope={j.id} />{/key}</div>{/if}
      </div>
      <div bind:this={panel} role="tabpanel" id="drawer-panel-{shown.tab}" aria-labelledby="drawer-tab-{shown.tab}" tabindex="0" class="min-h-0 flex-1 overscroll-contain {shown.tab === 'log' ? 'overflow-hidden' : 'overflow-y-auto'} p-5 md:p-6 flex flex-col gap-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-line-strong focus-visible:-outline-offset-2">
        {#if shown.tab === 'thread'}
          <ThreadPanel job={j} requests={d.requests ?? []} opening={threadOpening(d)} events={d.events ?? []} baseline={S.drawer.threadAtOpen} />
        {:else if shown.tab === 'log'}
          <!-- Keyed by job id (and owner transcript), so the drawer's 2 s refresh never re-creates the log or its stream; `active`
               closes the stream as soon as the drawer closes, though its last view stays while it slides out. -->
          {#key logKey}<SessionLog scope={j.id} active={open} transcript={ownerLog} stage={j.stage} controls={false} fill />{/key}
        {:else if shown.tab === 'agents'}
          {#key j.id}<AgentsTab job={j.id} detail={d} active={open} />{/key}
        {:else if shown.tab === 'files'}
          {@const file = shown.file}
          {@const content = shown.content}
          <div class="grid md:grid-cols-[180px_1fr] gap-4">
            <div class="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">{#each d.files as f (f)}<button class="block w-full text-left truncate px-2 py-1 text-sm font-mono {file === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}" onclick={() => loadFile(f)}>{f}</button>{/each}</div>
            <div class="min-w-0">
              {#if file && content}
                {#if 'html' in content}
                  <!-- svelte-ignore a11y_missing_attribute (no title, as on main: the iframe sits under the file list that names it) -->
                  <iframe sandbox="" class="w-full h-[70vh] border border-line bg-white" src="/api/jobs/{encodeURIComponent(j.id)}/raw?path={encodeURIComponent(file)}"></iframe>
                {:else if file.endsWith('.md')}
                  <div class="flex justify-end mb-2"><MarkdownToggle surface="files" /></div>
                  {#if mdView.files === 'rendered'}
                    <div class="prose">{@html md(content.text)}</div>
                  {:else}
                    <pre class="selectable text-[13px] font-mono whitespace-pre-wrap break-words bg-raised p-3">{content.text}</pre>
                  {/if}
                {:else}
                  <pre class="selectable text-[13px] font-mono whitespace-pre-wrap break-words bg-raised p-3">{content.text}</pre>
                {/if}
              {:else}
                <div class="text-sm text-muted">{$t('drawer.noFiles')}</div>
              {/if}
            </div>
          </div>
        {:else if shown.tab === 'timeline'}
          <ul>
            {#each events as e, i (i)}
              {@const x = eventDetail(e, { tokens: tokensShort, dur })}
              {@const by = actorLabel(e)}
              <li class="flex gap-3 py-1.5 border-b border-line text-sm">{#if i < fresh}<span class="dot spark size-1.5 shrink-0 self-center" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="text-muted whitespace-nowrap w-16 shrink-0">{ago(e.ts, ticker.now)}</span><span class="font-mono text-gleam shrink-0 w-28 truncate">{e.type}</span><span class="min-w-0 break-words">{#if isForemanEvent(e)}<Chip tone="live" extra="sm mr-1.5" text={$t('drawer.foreman')} />{/if}{x.pre}{#if x.bold !== null}<b>{x.bold}</b>{/if}{x.post}{#if by}<span class="muted ml-1.5" title={$t('drawer.actorSource', { source: by.source })}>{$t('drawer.by', { login: by.login })}</span>{/if}</span></li>
            {/each}
          </ul>
        {:else if shown.tab === 'details'}
          {#if j.reason}<div><div class="label">{$t('drawer.reason')}</div><div class="text-sm break-words">{j.reason}</div></div>{/if}
          <ProgressBar progress={j.progress} />
          <EnvironmentSection job={j} />
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            {@render fact($t('drawer.branch'), j.branch ?? '—', 'branch')}{@render fact($t('drawer.base'), j.base ?? '—', 'branch')}{@render fact($t('drawer.port'), j.port ?? '—')}{@render fact($t('drawer.worktree'), j.worktree ?? '—')}
            <div><div class="label">{$t('drawer.pr')}</div><div class="mono text-[13px] break-all selectable">{#if prUrl}<a class="text-gleam" href={prUrl} target="_blank" rel="noopener"><Icon name="pull-request" class="sm mr-1 inline-block align-[-2px]" />#{j.pr?.number}</a>{:else}—{/if}</div></div>
            <div><div class="label">{$t('drawer.issues')}</div><div class="mono text-[13px] break-all selectable flex flex-wrap gap-x-2">{#each j.issues ?? [] as issue, n (n)}{@const issueUrl = safeUrl(issue.url)}{#if issueUrl}<a class="text-gleam" href={issueUrl} target="_blank" rel="noopener">{#if issueUrl.startsWith('https://github.com/')}<Icon name="github" class="sm mr-1 inline-block align-[-2px]" />{/if}{issue.ref ?? $t('drawer.link')}</a>{:else}<span>{issue.ref ?? '—'}</span>{/if}{:else}—{/each}</div></div>
            {@render fact($t('drawer.session'), j.lease?.driver ?? '—')}{@render fact($t('drawer.created'), ago(j.createdAt, ticker.now))}{@render fact($t('drawer.updated'), ago(j.updatedAt, ticker.now))}
          </div>
          <RepoSection job={j} />
          <DepSection job={j} />
          {#if matrix}
            <div class="plate flat"><div class="overflow-x-auto">
              <table class="tbl">
                <thead><tr><th>{$t('table.round')}</th><th>{$t('drawer.verify')}</th>{#if hasVerifiers}<th>{$t('drawer.verifiers')}</th>{/if}{#each matrix.reviewers as r (r)}<th>{r}</th>{/each}</tr></thead>
                <tbody>
                  {#each matrix.rounds as r (r)}
                    {@const verify = j.verify?.[r]}
                    {@const vf = verifierResults[r]}
                    {@const vfText = vf ? $t('drawer.verifiersTitle', { blocking: $t('drawer.verifiersBlocking', { count: vf.blocking }), warnings: $t('drawer.verifiersWarnings', { count: vf.warned }) }) : undefined}
                    <tr>
                      <td class="num">{r}</td>
                      <td>{#if verify}<Chip tone={verify === 'PASS' ? 'ok' : 'bad'} text={verify} />{:else}—{/if}</td>{#if hasVerifiers}<td class="whitespace-nowrap" title={vfText}>{#if vf}<Chip tone={verifierTone(vf)} text={vf.outcome} />{#if vf.warned > 0}<span class="muted num ml-1" aria-hidden="true">{$t('drawer.verifiersWarnings', { count: vf.warned })}</span>{/if}<span class="sr-only">{vfText}</span>{:else}—{/if}</td>{/if}{#each matrix.reviewers as name (name)}{@const v = j.verdicts?.[r]?.[name]}<td>{#if v}<Chip tone={v === 'PASS' ? 'ok' : 'bad'} text={v} />{:else}—{/if}</td>{/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div></div>
          {/if}
          <BudgetPanel job={j} />
          {#if usageRows.length}
            <div class="plate flat"><div class="overflow-x-auto">
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
          <ScreenshotsPanel jobId={j.id} files={d.screenshots ?? []} />
          {#if mergeNowOffered(j)}{#key j.id}<MergeNowSection job={j} />{/key}{/if}
          {#key j.id}<DeleteJobSection job={j} />{/key}
        {/if}
      </div>
      {#if shown.tab === 'thread'}<ThreadLive agents={running} session={activity} cost={j.usage?.estCostUsd} onopen={() => selectTab('log', true)} />{/if}
    </div>
    <ActionDock job={j} />
  {/if}
</aside>
