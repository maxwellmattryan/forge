<!-- The status bar: one slim fixed row at the bottom of every view. Left, the Foreman (always: the supervisor above the
     pool, accented, on or off), Needs you (an icon-only bell and the count of decisions and permission prompts waiting), the
     daemon (a plain `Daemon live/cap` count) and (md and up) holds and waits; then the facts strip (FOCUS job id while a job is focused, a button to its drawer · FORGE version · API · SESSIONS live dot and count · SHEET); right, the model and the
     connection. It holds no text field: "New job or command" lives in the sidebar. Each indicator opens one popover, a
     sibling after the bar: a fixed element with a z-index is its own stacking context, so a popover inside the bar could
     never rise above a full job pane.
     Stacking, from the back: sidebar z-10, this bar z-35, a full job pane z-40 (inside main's isolated context), popovers
     z-42, Settings and the palette z-45, toast z-50. At md and up the bar spans the content column only, so the sidebar
     keeps its full height, and the job pane always ends at the bar's top edge. Session errors, titles and model strings are untrusted and render
     as text.
     The facts strip takes what the clusters leave (basis 0) and drops facts from the right as it runs short (see
     factsHidden). Each cluster holds its indicators in a max-content row; when the row is wider than the cluster, the next
     level of text goes sr-only (see fit()), so a visible label is always whole, never cut to an ellipsis. Below md every
     indicator is a glyph or a dot. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import LiveDot from './LiveDot.svelte';
  import Popover from './Popover.svelte';
  import ConnectionPanel from './statusbar/ConnectionPanel.svelte';
  import DaemonPanel from './statusbar/DaemonPanel.svelte';
  import NeedsPanel from './statusbar/NeedsPanel.svelte';
  import ForemanPanel from './statusbar/ForemanPanel.svelte';
  import ModelPanel from './statusbar/ModelPanel.svelte';
  import SpendChip from './SpendChip.svelte';
  import Tooltip from './Tooltip.svelte';
  import { API_VERSION } from '../lib/types.ts';
  import type { DaemonPoolState } from '../lib/types.ts';
  import { mergePoolState, poolModel, postDaemon } from '../lib/daemon.ts';
  import { FACTS_MAX, barModel, connectionState, factsHidden, modelSummary, promptAnnouncement, summaryText } from '../lib/statusbar.ts';
  import { activeSessions } from '../lib/live.ts';
  import { INBOX_SCOPE, OFFICE_SCOPE } from '../lib/types.ts';
  import { VIEWS, inboxGroups, viewIndex, type ViewId } from '../lib/view.ts';
  import { S, forgeToken, openDrawer, refresh } from '../lib/app.svelte.ts';
  import { focusFact } from '../lib/focus.ts';
  import { closePopover, focusInPopover, keepFocus, openPopover, popover, reanchor } from '../lib/popover.svelte.ts';
  import type { PopoverId } from '../lib/popover.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  // Follows each new /api/state (assigned only when it changed); POST replies overwrite it in between.
  let pool = $derived<Partial<DaemonPoolState> | null>(S.data?.daemons ?? null);
  let pending = $state(false);
  const model = $derived(poolModel(pool, { pending }));
  const bar = $derived(barModel(pool, { pending }));
  const models = $derived(modelSummary(S.data?.config?.models));
  const conn = $derived(connectionState({ online: S.online, apiVersion: S.data?.apiVersion, clientApi: API_VERSION }));
  const active = $derived(activeSessions(S.data?.daemons));
  // The job being QA-ed by hand (forge focus), when it is still in the list and active; nothing renders otherwise.
  const focus = $derived(focusFact(S.data));
  const focusTitle = $derived(focus ? $t('statusbar.focus.title', { id: focus.id, title: focus.title }) : undefined);
  // The Needs-you badge: the decisions waiting on a person plus every pending permission prompt in the pool (the
  // popover's first two sections).
  const needs = $derived(inboxGroups(S.data?.jobs ?? []).urgent.length);
  const needsTotal = $derived(needs + bar.prompts);
  // One active session per line, the inbox session and the office by name.
  const activeTitle = $derived(active.count ? active.ids.map((id) => (id === INBOX_SCOPE ? $t('live.inbox') : id === OFFICE_SCOPE ? $t('live.office') : id)).join('\n') : $t('live.none'));
  // The same map Nav.svelte builds, for the SHEET fact.
  const viewLabels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
    project: $t('nav.project'),
  });

  /**
   * How much text each part hides, lowest value first. Left: 1 the "Daemon" word, 2 the reasons of held and waiting, 3 held
   * and waiting (the Daemon indicator takes them: its title, its sr-only text and a warn glyph), 4 the Daemon's live/cap
   * (its glyph shows), 5 the "Foreman" word (its glyph, live dot and prompt count stay): the supervisor keeps its name
   * longest. The Needs-you bell is icon-only at every width, so it adds no level. Right: 1 the provider and the effort, 2 the model label, 3 the
   * connection's word while it is Live or Connecting, and "needed" after "Update", 4 the rest of the connection's word.
   * Facts, before either cluster: 1 SHEET, 2 API, 3 the SESSIONS word, 4 the FORGE word, 5 the FOCUS word (lib/statusbar.ts factsHidden).
   */
  let left = $state(0);
  let right = $state(0);
  let facts = $state(0);
  let fits = $state(0);
  const LEFT_MAX = 5;
  const RIGHT_MAX = 4;
  const hid = $derived(factsHidden(facts));
  let fitting = 0;
  let phone = $state(typeof matchMedia === 'function' ? !matchMedia('(width >= 48rem)').matches : false);

  /** Tone → text colour, whole literals so Tailwind sees them. */
  const TONE_TEXT: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', gleam: 'text-gleam', live: 'text-gleam', muted: 'text-muted' };
  /** Connection's static dot: only LiveDot pulses. */
  const CONN_DOT: Record<string, string> = { muted: 'dot hollow', ok: 'dot ok', warn: 'dot bg-warn', bad: 'dot bg-bad' };

  /** Held and waiting jobs whose buttons are not shown (fit level 3, or below md): the Daemon indicator speaks for them. */
  const holdsOut = $derived((phone || left >= 3) && (bar.held > 0 || bar.waiting > 0));
  const holdText = $derived(
    [...(bar.held ? [$t('daemon.held', { count: bar.held })] : []), ...(bar.waiting ? [$t('daemon.waiting', { count: bar.waiting })] : [])].join(', '),
  );
  // A hidden hold or wait tones the daemon glyph warn, so the bar still says something needs a look.
  const daemonTone = $derived(bar.daemon.off ? 'muted' : holdsOut && bar.daemon.pill.tone !== 'bad' ? 'warn' : bar.daemon.pill.tone);
  // The office pill tones the Foreman's glyph only while the daemon runs it.
  const foremanTone = $derived(bar.foreman.on && bar.foreman.daemon ? bar.foreman.pill.tone : 'muted');
  const connWord = $derived(
    conn.state === 'connecting' ? $t('statusbar.conn.connecting') : conn.state === 'offline' ? $t('statusbar.conn.offline') : conn.state === 'outdated' ? $t('statusbar.conn.outdated') : $t('statusbar.conn.live'),
  );
  // Live and Connecting differ by shape (a filled or a hollow dot); Offline and Update needed keep their word at every width.
  const connQuiet = $derived(conn.state === 'live' || conn.state === 'connecting');
  const modelText = $derived(summaryText(models, $t('statusbar.model.session'), (effort) => $t('statusbar.model.effort', { effort })));
  // Tooltips with the full label, only while part of an indicator's text is hidden: a title that repeats the visible
  // label is read a second time as the description.
  // The Foreman's and the Daemon's state words are never visible, so their titles always carry them.
  const titles = $derived({
    foreman: !bar.foreman.on
      ? $t('statusbar.foreman.off')
      : [
          bar.foreman.daemon ? `${$t('statusbar.foreman.name')} · ${bar.foreman.pill.label}` : $t('statusbar.foreman.daemonOff'),
          ...(bar.foreman.prompts ? [$t('statusbar.foreman.prompts', { count: bar.foreman.prompts })] : []),
        ].join(' · '),
    daemon: [
      bar.daemon.off ? $t('statusbar.daemon.off') : $t('daemon.pill', { label: bar.daemon.pill.label }),
      $t('daemon.live', { live: bar.daemon.off ? 0 : bar.daemon.live, cap: bar.daemon.cap }),
      ...(holdsOut ? [holdText] : []),
    ].join(' · '),
    needs: [
      $t('statusbar.needs.name'),
      ...(needs > 0 ? [$t('statusbar.needs.count', { count: needs })] : []),
      ...(bar.prompts > 0 ? [$t('permission.heading', { count: bar.prompts })] : []),
    ].join(' · '),
    model: `${$t('statusbar.model.name')} · ${modelText}`,
    connection: `${$t('statusbar.conn.title')} · ${connWord}`,
  });

  /** The Daemon popover's Foreman row: the Foreman popover replaces it, anchored on the bar's own Foreman button. */
  function openForeman(): void {
    const el = footer?.querySelector<HTMLElement>('[data-popover="foreman"]');
    if (el) openPopover('foreman', el);
  }

  async function act(action: 'start' | 'stop'): Promise<void> {
    pending = true;
    try {
      const st = await postDaemon(action, forgeToken());
      pending = false;
      pool = mergePoolState(pool, st);
      refresh();
    } catch (err) {
      pending = false;
      toast($t('daemon.failed', { action, error: err instanceof Error ? err.message : String(err) }), true);
    }
    // Start or Stop turned disabled under the keyboard: focus back on the popover, not the body.
    keepFocus();
  }

  // The live region speaks only when the pool-wide prompt count rises; it is emptied first, so the same count can speak again.
  let lastPrompts = 0;
  let announcement = $state('');
  $effect(() => {
    const next = bar.prompts;
    const say = promptAnnouncement(lastPrompts, next);
    lastPrompts = next;
    if (say === null) return;
    const text = $t('permission.heading', { count: say });
    announcement = '';
    tick().then(() => (announcement = text));
  });

  // A job's drawer opened by any route closes the popover; focus goes back to the indicator only if it was inside.
  let lastDrawer: string | null = untrack(() => S.drawer.id);
  $effect(() => {
    const id = S.drawer.id;
    if (id !== null && id !== lastDrawer) untrack(() => closePopover(focusInPopover() ? 'navigate' : 'external'));
    lastDrawer = id;
  });

  // ---------- fitting the clusters ----------
  let footer = $state<HTMLElement>();
  let leftBox = $state<HTMLDivElement>();
  let leftRow = $state<HTMLDivElement>();
  let rightBox = $state<HTMLDivElement>();
  let rightRow = $state<HTMLDivElement>();
  let factsBox = $state<HTMLDivElement>();

  function overflows(box: HTMLElement | undefined, row: HTMLElement | undefined): boolean {
    if (!box || !row) return false;
    const s = getComputedStyle(box);
    return row.getBoundingClientRect().width > box.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 0.5;
  }

  /** A box whose content is wider than it (the facts strip clips its overflow). */
  const cut = (el: HTMLElement | undefined): boolean => Boolean(el && el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 0.5);

  /** From whole labels down, one level at a time, until each part fits: the facts first, then the clusters. All in
   *  microtasks, so nothing flickers. */
  async function fit(): Promise<void> {
    const me = ++fitting;
    phone = !matchMedia('(width >= 48rem)').matches;
    left = 0;
    right = 0;
    facts = 0;
    await tick();
    while (me === fitting && facts < FACTS_MAX && cut(factsBox)) {
      facts++;
      await tick();
    }
    while (me === fitting && left < LEFT_MAX && overflows(leftBox, leftRow)) {
      left++;
      await tick();
    }
    while (me === fitting && right < RIGHT_MAX && overflows(rightBox, rightRow)) {
      right++;
      await tick();
    }
    if (me === fitting) fits++;
  }

  // Refit when what the labels say changes, when the bar resizes, and once the fonts arrive.
  $effect(() => {
    void bar;
    void models;
    void conn.state;
    void S.data;
    void S.view;
    void active.count;
    void $t;
    untrack(() => fit());
  });
  $effect(() => {
    if (!footer) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(footer);
    document.fonts?.ready.then(() => fit());
    return () => ro.disconnect();
  });

  // An indicator that stops rendering or showing takes its popover with it, unless another indicator for the same popover
  // remains (a cleared hold hands the Daemon popover back to the Daemon button). Focus inside goes to the view's heading.
  $effect(() => {
    void bar;
    void S.data;
    void fits;
    untrack(() => {
      const open = popover.open;
      const anchor = popover.anchor;
      if (open === null || !anchor || (anchor.isConnected && anchor.getClientRects().length > 0)) return;
      const other = [...(footer?.querySelectorAll<HTMLElement>(`[data-popover="${open}"]`) ?? [])].find((b) => b.getClientRects().length > 0);
      if (other) reanchor(other);
      else closePopover('gone');
    });
  });

  // `#/inbox` (the old Needs-you page) opens the Needs-you popover once the data and its button are in.
  let needsButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (!S.openNeeds || !S.data || !needsButton) return;
    const anchor = needsButton;
    untrack(() => {
      S.openNeeds = false;
      if (popover.open !== 'needs') openPopover('needs', anchor);
    });
  });

  const expanded = (id: PopoverId): boolean => popover.open === id;
  const controls = (id: PopoverId): string | undefined => (popover.open === id ? `popover-${id}` : undefined);
</script>

<footer
  bind:this={footer}
  id="statusbar"
  aria-label={$t('statusbar.label')}
  class="fixed bottom-0 right-0 left-0 md:left-(--size-sidebar) z-35 chrome border-t border-line-strong h-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] flex items-center gap-1 px-1 md:gap-3.5 md:px-2"
>
  <div bind:this={leftBox} class="flex min-w-0 items-center overflow-x-clip px-1">
    <div bind:this={leftRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <!-- The supervisor: always shown, accented rather than ghost. Its state word is only in the sr-only text and title. -->
        <button class="btn sm foreman {bar.foreman.on ? '' : 'off'} max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="foreman" title={bar.foreman.on || phone || left >= 5 ? titles.foreman : undefined} aria-haspopup="dialog" aria-expanded={expanded('foreman')} aria-controls={controls('foreman')} onclick={(e) => openPopover('foreman', e.currentTarget)}>
          <span class="inline-flex {TONE_TEXT[foremanTone]}"><Icon name="foreman" /></span>
          {#if bar.foreman.on}
            <LiveDot on={bar.foreman.daemon && bar.foreman.active} />
            <span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''}">{$t('statusbar.foreman.name')}</span>
            <span class="sr-only">{', '}{bar.foreman.daemon ? bar.foreman.pill.label : $t('statusbar.daemon.off')}</span>
            {#if bar.foreman.prompts}<span class="num text-warn"><span aria-hidden="true">{bar.foreman.prompts}</span><span class="sr-only">{', '}{$t('statusbar.foreman.prompts', { count: bar.foreman.prompts })}</span></span>{/if}
          {:else}
            <span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''}">{$t('statusbar.foreman.off')}</span>
          {/if}
        </button>
        <!-- The one place for everything that needs a person: icon-only at every width (the bell and the badge speak; its
             words are sr-only), so it adds no fit level. The badge counts decisions plus pool-wide permission prompts. -->
        <button bind:this={needsButton} class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="needs" aria-haspopup="dialog" aria-expanded={expanded('needs')} aria-controls={controls('needs')} onclick={(e) => openPopover('needs', e.currentTarget)}>
          <span class="inline-flex {needsTotal > 0 ? 'text-fg' : 'text-muted'}"><Icon name="bell" /></span>
          {#if needsTotal > 0}<span class="chip you num" aria-hidden="true">{needsTotal}</span>{/if}
          <span class="sr-only">{$t('statusbar.needs.name')}{#if needs > 0}{', '}{$t('statusbar.needs.count', { count: needs })}{/if}{#if bar.prompts > 0}{', '}{$t('permission.heading', { count: bar.prompts })}{/if}</span>
        </button>
        <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="daemon" title={titles.daemon} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}>
          <span class="inline-flex {left >= 4 || holdsOut ? '' : 'md:hidden'} {TONE_TEXT[daemonTone]}"><Icon name="daemon" /></span>
          <LiveDot on={bar.daemon.active} />
          <span class="max-md:sr-only {left >= 4 ? 'sr-only' : ''} {bar.daemon.off ? 'text-muted' : ''}"><span class={left >= 1 ? 'sr-only' : ''}>{$t('statusbar.daemon.title')}{' '}</span><span class="num">{bar.daemon.off ? 0 : bar.daemon.live}/{bar.daemon.cap}</span></span>
          <span class="sr-only">{' '}{$t('statusbar.daemon.sessions')}{', '}{bar.daemon.off ? $t('statusbar.daemon.off') : bar.daemon.pill.label}</span>
          {#if holdsOut}<span class="sr-only">{', '}{holdText}</span>{/if}
        </button>
        <!-- The month's spend: md and up, and the first thing to go (with held and waiting) when the cluster runs short. -->
        {#if S.data.budget}<SpendChip budget={S.data.budget} extra="max-md:hidden {left >= 3 ? 'hidden!' : ''}" />{/if}
        {#if bar.held}
          <button class="btn sm ghost max-md:hidden {left >= 3 ? 'hidden!' : ''}" data-popover="daemon" title={left >= 2 ? $t('daemon.held', { count: bar.held }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="text-warn">{$t('statusbar.held.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.held.rest')}</span>{' '}({bar.held})</span></button>
        {/if}
        {#if bar.waiting}
          <button class="btn sm ghost max-md:hidden {left >= 3 ? 'hidden!' : ''}" data-popover="daemon" title={left >= 2 ? $t('daemon.waiting', { count: bar.waiting }) : undefined} aria-haspopup="dialog" aria-expanded={expanded('daemon')} aria-controls={controls('daemon')} onclick={(e) => openPopover('daemon', e.currentTarget)}><span class="text-warn">{$t('statusbar.waiting.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.waiting.rest')}</span>{' '}({bar.waiting})</span></button>
        {/if}
      {/if}
    </div>
  </div>

  <!-- The facts: what the clusters leave, never wrapped. Each dropped fact goes sr-only, so the strip still reads whole.
       Below md only the version and the sessions dot and count stay, and while a job is focused its glyph takes the
       version's place. -->
  <div bind:this={factsBox} class="facts flex-1 basis-0">
    {#if focus}<button id="footer-focus" class="inline-flex shrink-0 items-center gap-[5px] cursor-pointer hover:text-gleam focus-visible:-outline-offset-2 max-md:min-w-11 max-md:justify-center" title={focusTitle} onclick={() => openDrawer(focus.id)}><span class="inline-flex md:hidden text-gleam" aria-hidden="true"><Icon name="review" /></span><span class="k max-md:sr-only {hid.focusWord ? 'sr-only' : ''}">{$t('statusbar.facts.focus')}</span><span class="max-md:sr-only max-w-[24ch] truncate">{focus.id}</span><span class="sr-only">{', '}{focus.title}</span></button><span class="sep max-md:hidden!" aria-hidden="true"></span>{/if}
    <span id="footer-version"><span class="k max-md:sr-only {hid.forgeWord ? 'sr-only' : ''}">{$t('statusbar.facts.forge')}</span><span class={focus ? 'max-md:sr-only' : ''}>{S.data ? $t('statusbar.facts.version', { version: S.data.forgeVersion }) : '—'}</span></span>
    <span class="sep max-md:hidden! {hid.api ? 'hidden!' : ''}" aria-hidden="true"></span>
    <span class="max-md:sr-only {hid.api ? 'sr-only' : ''}"><span class="k">{$t('statusbar.facts.api')}</span>{S.data ? S.data.apiVersion : '—'}</span>
    <span class="sep" aria-hidden="true"></span>
    <span id="footer-sessions" title={activeTitle}><span class="k max-md:sr-only {hid.sessionsWord ? 'sr-only' : ''}">{$t('statusbar.facts.sessions')}</span><LiveDot on={active.count > 0} /><span class="num max-md:sr-only">{$t('statusbar.facts.sessionsValue', { count: active.count })}</span><span class="num md:hidden" aria-hidden="true">{active.count}</span></span>
    <span class="sep max-md:hidden! {hid.sheet ? 'hidden!' : ''}" aria-hidden="true"></span>
    <span class="max-md:sr-only {hid.sheet ? 'sr-only' : ''}"><span class="k">{$t('statusbar.facts.sheet')}</span>{$t('statusbar.facts.sheetValue', { view: viewLabels[S.view], index: viewIndex(S.view), total: VIEWS.length })}</span>
  </div>

  <div bind:this={rightBox} class="ml-auto flex min-w-0 items-center justify-end overflow-x-clip px-1">
    <div bind:this={rightRow} class="flex w-max items-center gap-0.5 md:gap-1">
      {#if S.data}
        <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="model" title={phone || right >= 1 ? titles.model : undefined} aria-haspopup="dialog" aria-expanded={expanded('model')} aria-controls={controls('model')} onclick={(e) => openPopover('model', e.currentTarget)}>
          <Icon name="agents" />
          <span class="sr-only">{$t('statusbar.model.name')}{' '}</span>
          <span class="max-md:sr-only {right >= 2 ? 'sr-only' : ''}">{#if models.provider}<span class={right >= 1 ? 'sr-only' : ''}>{models.provider}{' · '}</span>{/if}{models.label ?? $t('statusbar.model.session')}{#if models.effort}<span class={right >= 1 ? 'sr-only' : ''}>{' · '}{$t('statusbar.model.effort', { effort: models.effort })}</span>{/if}</span>
        </button>
      {/if}
      <button class="btn sm ghost max-md:min-w-11 max-md:justify-center max-md:focus-visible:-outline-offset-2" data-popover="connection" title={phone || right >= 3 ? titles.connection : undefined} aria-haspopup="dialog" aria-expanded={expanded('connection')} aria-controls={controls('connection')} onclick={(e) => openPopover('connection', e.currentTarget)}>
        <span class={CONN_DOT[conn.tone]} aria-hidden="true"></span>
        <span class="sr-only">{$t('statusbar.conn.title')}{' '}</span>
        {#if conn.state === 'outdated'}
          <span class="text-warn {right >= 4 ? 'sr-only' : ''}">{$t('statusbar.conn.outdatedWord')}<span class={right >= 3 ? 'sr-only' : ''}>{$t('statusbar.conn.outdatedRest')}</span></span>
        {:else}
          <span class="{connQuiet ? 'max-md:sr-only' : ''} {(connQuiet && right >= 3) || right >= 4 ? 'sr-only' : ''} {TONE_TEXT[conn.tone]}">{connWord}</span>
        {/if}
      </button>
    </div>
  </div>

  <div class="sr-only" aria-live="polite">{announcement}</div>
</footer>
<!-- The bell is icon-only at every width, so its name shows in a Tooltip (hidden while its popover is open), written
     outside the bar so the clusters it measures hold only their indicators. -->
<Tooltip anchor={needsButton} text={titles.needs} off={expanded('needs') === true} />

{#if popover.open !== null && popover.anchor}
  {@const open = popover.open}
  {#key open}
    <Popover
      id={open}
      title={open === 'foreman' ? $t('statusbar.foreman.title') : open === 'needs' ? $t('statusbar.needs.title') : open === 'daemon' ? $t('statusbar.daemon.title') : open === 'model' ? $t('statusbar.model.title') : $t('statusbar.conn.title')}
      anchor={popover.anchor}
      align={open === 'model' || open === 'connection' ? 'end' : 'start'}
      size={open === 'foreman' ? (bar.foreman.on ? 'chat' : 'wide') : open === 'needs' ? 'wide' : open === 'daemon' ? 'wide' : 'normal'}
      accent={open === 'foreman' ? 'foreman' : undefined}
    >
      {#if open === 'foreman'}<ForemanPanel foreman={bar.foreman} />
      {:else if open === 'needs'}{#if S.data}<NeedsPanel data={S.data} />{/if}
      {:else if open === 'daemon'}<DaemonPanel {model} {pending} {act} foreman={bar.foreman} {openForeman} />
      {:else if open === 'model'}<ModelPanel />
      {:else}<ConnectionPanel status={conn.state} />{/if}
    </Popover>
  {/key}
{/if}
