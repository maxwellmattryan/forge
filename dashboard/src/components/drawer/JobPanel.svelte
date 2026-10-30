<!-- The job panel, inside the drawer's shell (DrawerShell.svelte, shared with the issue panel). It renders the drawerView
     snapshot, so it changes only where the old renderDrawer() ran. Its header is four rows: the title with the close
     button, the meta line (id · round) with one right-aligned controls cluster, one badge row, and the live agent line
     while agents run; opened from the issue panel, a Back to <ref> button sits above them. Every row wraps, so it never
     scrolls sideways at any width. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import ActionDock from '../gates/ActionDock.svelte';
  import AgentActivity from '../sessions/AgentActivity.svelte';
  import AgentsTab from './AgentsTab.svelte';
  import CloseButton from '../ui/CloseButton.svelte';
  import Copyable from '../ui/Copyable.svelte';
  import CommandTrigger from './CommandTrigger.svelte';
  import Banner from '../ui/feedback/Banner.svelte';
  import BudgetPanel from '../metrics/BudgetPanel.svelte';
  import Chip from '../ui/Chip.svelte';
  import CountBadge from '../ui/CountBadge.svelte';
  import DeleteJobSection from './details/DeleteJobSection.svelte';
  import DepSection from './details/DepSection.svelte';
  import EffortChip from '../jobs/EffortChip.svelte';
  import EnvironmentSection from './details/EnvironmentSection.svelte';
  import LeaseChip from '../sessions/LeaseChip.svelte';
  import LiveDot from '../sessions/LiveDot.svelte';
  import MarkdownToggle from '../ui/MarkdownToggle.svelte';
  import MergeNowSection from './details/MergeNowSection.svelte';
  import PrChip from '../jobs/PrChip.svelte';
  import ProgressBar from '../jobs/ProgressBar.svelte';
  import RepoSection from './details/RepoSection.svelte';
  import ScreenshotsPanel from './details/ScreenshotsPanel.svelte';
  import SessionActivity from '../sessions/SessionActivity.svelte';
  import SessionControls from '../sessions/SessionControls.svelte';
  import SessionLog from '../logs/SessionLog.svelte';
  import SessionToggle from '../sessions/SessionToggle.svelte';
  import StateChip from '../jobs/StateChip.svelte';
  import ThreadLive from './ThreadLive.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import Icon from '../ui/Icon.svelte';
  import type { IconName } from '../../lib/ui/icons.ts';
  import { effortChip } from '../../lib/jobs/effort.ts';
  import { protectedSummary } from '../../lib/jobs/protected.ts';
  import { mergeNowOffered } from '../../lib/gates/merge-now.ts';
  import { STAGE_LABEL } from '../../lib/core/labels.ts';
  import { md, safeUrl } from '../../lib/text/markdown.ts';
  import { mdView } from '../../lib/text/md-view.svelte.ts';
  import { threadItems, threadMarks, threadOpening, unreadCount } from '../../lib/jobs/thread.ts';
  import { ago, dur, num, tokensShort, usd } from '../../lib/core/util.ts';
  import { currentProject } from '../../lib/core/project.ts';
  import { scopeVerbs } from '../../lib/shell/command.ts';
  import { S, backToIssue, closeDrawer, loadFile, setDrawerTab } from '../../lib/core/app.svelte.ts';
  import { refLabel } from '../../lib/project/issue-view.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import { freshCount, sessionActivity } from '../../lib/sessions/live.ts';
  import { t } from '../../lib/text/locale.ts';
  import { DRAWER_TABS, actorLabel, eventDetail, isChatEvent, isForemanEvent, moveDrawerTab, verdictMatrix, verifierRounds, verifierTone, type DrawerTab } from '../../lib/jobs/drawer.ts';
  import { slideMarker } from '../../lib/ui/marker.ts';

  /** The shell's: the job title takes focus through it on open. */
  let { focusTitle }: { focusTitle: Attachment<HTMLElement> } = $props();

  /** The page's project (a PROJECT_NAME, set before mount): the mockup frame's route is that project's. */
  const project = currentProject();
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
  let fileList = $state<HTMLDivElement>();
  let fileView = $state<HTMLDivElement>();
  // Closing the drawer, or opening another job from inside it, starts the next view at the top. A 2 s poll keeps the
  // id, so it never moves the scroll.
  $effect(() => {
    void S.drawer.id;
    untrack(() => {
      if (panel) panel.scrollTop = 0;
      if (head) head.scrollTop = 0;
    });
    untrack(() => {
      if (fileList) fileList.scrollTop = 0;
      if (fileView) fileView.scrollTop = 0;
    });
  });
  // Picking another file shows it from its top. This reads the file name, never `shown`: drawerView is a new object on
  // every 2 s refresh, which must keep the scroll.
  const openFile = $derived(shown?.file ?? null);
  $effect(() => {
    void openFile;
    if (fileView) fileView.scrollTop = 0;
  });
  /** The role a Thread row's Transcript button named: the Agents tab opens on it. Any other tab change clears it. */
  let agentFocus = $state<string | null>(null);
  /** The header and the tab strip never scroll away, so a new tab simply starts at its own top. */
  function selectTab(tab: DrawerTab, focus = false, role: string | null = null): void {
    agentFocus = role;
    setDrawerTab(tab);
    if (panel) panel.scrollTop = 0;
    if (focus) document.getElementById('drawer-tab-' + tab)?.focus();
  }
  function stripKey(e: KeyboardEvent): void {
    if (!shown) return;
    const next = moveDrawerTab(shown.tab, e.key);
    if (!next) return;
    e.preventDefault();
    selectTab(next, true);
  }
</script>

{#snippet fact(k: string, v: unknown, icon: IconName | null = null, copy = false)}
  <div><div class="label">{k}</div><div class="mono text-[13px] break-all selectable">{#if icon}<Icon name={icon} class="sm mr-1 inline-block align-[-2px] text-muted" />{/if}{#if copy && typeof v === 'string' && v !== '—'}<Copyable text={v} />{:else}{v}{/if}</div></div>
{/snippet}

<!-- The header (capped at 40%, scrolling inside itself when taller) and the tab strip stay put, the tab panel under them is
     the one scroller (on Log, the log pane is; on Files, the file list and the file view each scroll), and the action dock
     under it stays put on every tab. -->
  {#if view && 'error' in view}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6"><Banner msg={view.error} /></div>
  {:else if shown && job}
    {@const d = shown.detail}
    {@const j = job}
    {@const verbs = scopeVerbs(j).length > 0}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div bind:this={head} class="shrink-0 max-h-[40%] overflow-y-auto overscroll-contain p-5 md:p-6 pb-3 md:pb-4 flex flex-col gap-2">
        <!-- Opened from the issue panel (its card, Open job or an earlier job): Back returns to that issue. A local ref can be
             a long slug, so the label truncates at the header's width and the title carries it whole. -->
        {#if S.drawer.back}{@const back = S.drawer.back}{@const label = $t('drawer.backToIssue', { ref: refLabel(back) })}<button class="btn sm self-start min-w-0 max-w-full" title={label} onclick={backToIssue}><Icon name="chevron-down" class="sm shrink-0 rotate-90" /><span class="min-w-0 truncate">{label}</span></button>{/if}
        <div class="flex items-start justify-between gap-3"><h2 {@attach focusTitle} tabindex="-1" class="h sheet-title min-w-0">{j.title}</h2><CloseButton size="sm" label={$t('drawer.close')} onclick={closeDrawer} /></div>
        <!-- The meta line, then one right-aligned controls cluster: a daemon-backed job's session controls (here, not in its
             Log, so every tab has them; its Start/Stop sits apart, at the end of the tab row), then Command, nearest the
             close button. An interactive owner's job has no session controls, as its Log follows a transcript, and keeps
             the effort chip. ml-auto keeps the cluster right-aligned when it wraps under the meta line. -->
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><div class="mono text-[13px] muted min-w-0 break-all"><Copyable text={j.id} />{#if j.round}{' · '}<span class="whitespace-nowrap">{$t('job.round', { round: j.round, max: j.maxRounds })}</span>{/if}</div>{#if !ownerLog || verbs}<div class="ml-auto flex min-w-0 flex-wrap items-start justify-end gap-1.5">{#if !ownerLog}{#key j.id}<SessionControls scope={j.id} toggle={false} />{/key}{/if}{#if verbs}<CommandTrigger job={j.id} />{/if}</div>{/if}</div>
        <!-- One wrapping badge row: the job's chips, the lease, the session's activity, and last the reason, one truncated
             line that wraps onto its own line here when there is no room. -->
        <div class="flex min-w-0 flex-wrap items-center gap-1.5"><Chip tone="gleam" text={STAGE_LABEL[j.stage] ?? j.stage} /><StateChip job={j} />{#if prot}<Chip tone="warn" extra="max-w-full flex-wrap whitespace-normal" text={$t('job.protectedDrawer', { reasons: prot.reasons.join(' · ') })} />{/if}<PrChip pr={j.pr} />{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}{#if ownerLog}<EffortChip level={effort} />{/if}<LeaseChip owner={j.ownerStatus} />{#if activity}<SessionActivity {activity} extra="caption" />{/if}{#if j.reason}<span class="caption muted min-w-0 max-w-full truncate" title={j.reason}>{j.reason}</span>{/if}</div>
        <!-- On the Thread the live line under the conversation says what runs, so the header doesn't say it twice. -->
        {#if shown.tab !== 'thread' && running.length}<AgentActivity activity={running} expandable={true} />{/if}
      </div>
      <!-- Outside the scroller, so it never moves; the tabs scroll sideways when they outgrow a phone. A daemon-backed
           job's Start/Stop ends the row on its own, as far from the edge as the header's controls. -->
      <div class="shrink-0 z-20 solid flex">
        <div role="tablist" tabindex="-1" aria-label={$t('drawer.tabs')} {@attach slideMarker('[aria-selected="true"]', 'bar-bottom')} class="tabs slide-marker min-w-0 flex-1 pl-5 md:pl-6 overflow-x-auto overflow-y-hidden" onkeydown={stripKey}>{#each DRAWER_TABS as tab (tab)}<button role="tab" id="drawer-tab-{tab}" aria-selected={shown.tab === tab} aria-controls="drawer-panel-{tab}" tabindex={shown.tab === tab ? 0 : -1} class="tab shrink-0 whitespace-nowrap focus-visible:-outline-offset-2 {shown.tab === tab ? 'active' : ''}" onclick={() => selectTab(tab)}>{#if tab === 'thread'}<CountBadge count={unread} extra={unread > 0 ? 'pr-4' : ''}>{$t('drawer.threadTab')}</CountBadge>{#if unread > 0}<span class="sr-only">{', '}{$t('drawer.threadUnread', { count: unread })}</span>{/if}{:else if tab === 'log'}{$t('drawer.logTab')}{#if activity?.kind === 'working'}<span class="inline-flex ml-1.5 align-middle"><LiveDot on={true} /></span><span class="sr-only">{$t('live.working')}</span>{/if}{:else if tab === 'agents'}{$t('drawer.agentsTab')}{#if running.length}<span class="muted num ml-1">({running.length})</span>{/if}{:else if tab === 'files'}{$t('drawer.files')}{:else if tab === 'timeline'}{$t('drawer.timeline')} <span class="muted num">({d.events.length})</span>{:else if tab === 'details'}{$t('drawer.detailsTab')}{/if}</button>{/each}</div>
        {#if !ownerLog}<div class="flex shrink-0 items-center border-b border-line pl-3 pr-5 md:pr-6">{#key j.id}<SessionToggle scope={j.id} />{/key}</div>{/if}
      </div>
      <div bind:this={panel} role="tabpanel" id="drawer-panel-{shown.tab}" aria-labelledby="drawer-tab-{shown.tab}" tabindex="0" class="min-h-0 flex-1 overscroll-contain {shown.tab === 'log' || shown.tab === 'files' ? 'overflow-hidden' : 'overflow-y-auto'} p-5 md:p-6 flex flex-col gap-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-line-strong focus-visible:-outline-offset-2">
        {#if shown.tab === 'thread'}
          <ThreadPanel job={j} requests={d.requests ?? []} opening={threadOpening(d)} events={d.events ?? []} baseline={S.drawer.threadAtOpen} transcripts={(d.agents ?? []).filter((a) => a.transcript).map((a) => a.role)} onrole={(role) => selectTab('agents', true, role)} />
        {:else if shown.tab === 'log'}
          <!-- Keyed by job id (and owner transcript), so the drawer's 2 s refresh never re-creates the log or its stream; `active`
               closes the stream as soon as the drawer closes, though its last view stays while it slides out. -->
          {#key logKey}<SessionLog scope={j.id} active={open} transcript={ownerLog} stage={j.stage} controls={false} fill />{/key}
        {:else if shown.tab === 'agents'}
          {#key j.id}<AgentsTab job={j.id} detail={d} active={open} focus={agentFocus} />{/key}
        {:else if shown.tab === 'files'}
          {@const file = shown.file}
          {@const content = shown.content}
          {#if d.files.length}
            <div bind:this={fileList} class="shrink-0 max-h-[30%] overflow-y-auto overscroll-contain flex flex-col gap-0.5 border-b border-line pb-3">{#each d.files as f (f)}<button class="block w-full shrink-0 text-left truncate focus-visible:-outline-offset-2 px-2 py-1 text-sm font-mono {file === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}" onclick={() => loadFile(f)}>{f}</button>{/each}</div>
          {/if}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
          <div bind:this={fileView} role="region" aria-label={file ?? $t('drawer.files')} tabindex={d.files.length ? 0 : undefined} class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain flex flex-col focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-line-strong focus-visible:-outline-offset-2">
              {#if file && content}
                {#if 'html' in content}
                  <!-- svelte-ignore a11y_missing_attribute (no title, as on main: the iframe sits below the file list that names it) -->
                  <iframe sandbox="" class="w-full min-h-64 flex-1 border border-line bg-white" src="/api/p/{project}/jobs/{encodeURIComponent(j.id)}/raw?path={encodeURIComponent(file)}"></iframe>
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
        {:else if shown.tab === 'timeline'}
          <ul>
            {#each events as e, i (i)}
              {@const x = eventDetail(e, { tokens: tokensShort, dur })}
              {@const by = actorLabel(e)}
              <li class="flex gap-3 py-1.5 border-b border-line text-sm">{#if i < fresh}<span class="dot spark size-1.5 shrink-0 self-center" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="text-muted whitespace-nowrap w-16 shrink-0">{ago(e.ts, ticker.now)}</span><span class="font-mono text-gleam shrink-0 w-28 truncate">{e.type}</span><span class="min-w-0 break-words">{#if isForemanEvent(e)}<Chip tone="live" extra="sm mr-1.5" text={$t('drawer.foreman')} />{/if}{#if isChatEvent(e)}<Chip tone="info" extra="sm mr-1.5" text={$t('drawer.chat')} />{/if}{x.pre}{#if x.bold !== null}<b>{x.bold}</b>{/if}{x.post}{#if by}<span class="muted ml-1.5" title={$t('drawer.actorSource', { source: by.source })}>{$t('drawer.by', { login: by.login })}</span>{/if}</span></li>
            {/each}
          </ul>
        {:else if shown.tab === 'details'}
          {#if j.reason}<div><div class="label">{$t('drawer.reason')}</div><div class="text-sm break-words">{j.reason}</div></div>{/if}
          <ProgressBar progress={j.progress} />
          <EnvironmentSection job={j} />
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            {@render fact($t('drawer.branch'), j.branch ?? '—', 'branch', true)}{@render fact($t('drawer.base'), j.base ?? '—', 'branch', true)}{@render fact($t('drawer.port'), j.port ?? '—')}{@render fact($t('drawer.worktree'), j.worktree ?? '—', null, true)}
            <div><div class="label">{$t('drawer.pr')}</div><div class="mono text-[13px] break-all selectable">{#if prUrl}<a class="text-gleam" href={prUrl} target="_blank" rel="noopener"><Icon name="pull-request" class="sm mr-1 inline-block align-[-2px]" />#{j.pr?.number}</a>{:else}—{/if}</div></div>
            <div><div class="label">{$t('drawer.issues')}</div><div class="mono text-[13px] break-all selectable flex flex-wrap gap-x-2">{#each j.issues ?? [] as issue, n (n)}{@const issueUrl = safeUrl(issue.url)}{#if issueUrl}<a class="text-gleam" href={issueUrl} target="_blank" rel="noopener">{#if issueUrl.startsWith('https://github.com/')}<Icon name="github" class="sm mr-1 inline-block align-[-2px]" />{/if}{issue.ref ?? $t('drawer.link')}</a>{:else}<span>{issue.ref ?? '—'}</span>{/if}{:else}—{/each}</div></div>
            {@render fact($t('drawer.session'), j.lease?.driver ?? '—', null, true)}{@render fact($t('drawer.created'), ago(j.createdAt, ticker.now))}{@render fact($t('drawer.updated'), ago(j.updatedAt, ticker.now))}
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
