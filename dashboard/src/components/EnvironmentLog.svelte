<!-- The Environment card's log viewer: one source (`dev`, or `backing:<name>`) followed live from
     /api/jobs/:id/environment/logs. The stream is open only while this is mounted and the tab is visible. Every line is
     untrusted process output and renders as text. Paused, it keeps the scroll position and still collects lines.
     A station terminal like SessionLog: a nameplate (lamp, title, ended note) on the bezel and a screen. The server opens
     every stream with its last lines, so lines within SETTLE_MS of an open are backlog and never heat. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import IconButton from './IconButton.svelte';
  import Lamp from './Lamp.svelte';
  import { atBottom } from '../lib/logs/session-log.ts';
  import { logStreamUrl, parseFrame, pushLines } from '../lib/project/environment.ts';
  import { S } from '../lib/core/app.svelte.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import { settled } from '../lib/ui/motion.ts';
  import { LIVE_LAMPS, isLiveLine, lampState, streaming } from '../lib/logs/station.ts';
  import { t } from '../lib/text/locale.ts';

  let { job, source, label, onclose }: { job: string; source: string; label: string; onclose: () => void } = $props();

  let lines = $state.raw<string[]>([]);
  let follow = $state(true);
  let ended = $state(false);
  /** The server refused the stream (no dev log yet, a container it won't show, too many streams). */
  let failed = $state(false);
  let pane = $state<HTMLDivElement>();
  let es: EventSource | null = null;
  /** Whether a stream is open: the lamp waits on a quiet one. */
  let streamOpen = $state(false);
  /** When the stream opened or reopened: lines within SETTLE_MS of it are the server's backlog. */
  let openedAt: number | null = null;
  let lastLiveAt = $state<number | null>(null);

  function open(): void {
    if (es || ended || document.visibilityState !== 'visible') return;
    // A reopened stream starts again from the last lines: drop what it will send again.
    lines = [];
    const s = new EventSource(logStreamUrl(job, source));
    openedAt = Date.now();
    s.onopen = () => (openedAt = Date.now());
    s.onmessage = (e) => {
      const line = parseFrame(e.data);
      if (line === null) return;
      lines = pushLines(lines, [line]);
      const now = Date.now();
      if (isLiveLine(openedAt, now)) lastLiveAt = now;
    };
    s.addEventListener('end', () => {
      ended = true;
      close();
    });
    // A dropped connection reconnects on its own (CONNECTING); a refusal (any non-200 answer) closes it for good.
    s.onerror = () => {
      if (s.readyState !== EventSource.CLOSED) return;
      failed = true;
      ended = true;
      close();
    };
    es = s;
    streamOpen = true;
  }
  function close(): void {
    es?.close();
    es = null;
    streamOpen = false;
    openedAt = null;
    lastLiveAt = null;
  }
  function visibilityChanged(): void {
    if (document.visibilityState === 'visible') open();
    else close();
  }

  // A new job or source is a new stream; nothing else reopens it.
  $effect(() => {
    void job;
    void source;
    untrack(() => {
      ended = false;
      failed = false;
      open();
    });
    return close;
  });
  onDestroy(close);

  $effect.pre(() => {
    void lines;
    if (!pane || !follow) return;
    const p = pane;
    tick().then(() => (p.scrollTop = p.scrollHeight));
  });

  // Scrolling up pauses; scrolling back to the bottom follows again, as SessionLog does.
  function onScroll(): void {
    if (pane) follow = atBottom(pane.scrollHeight, pane.scrollTop, pane.clientHeight);
  }
  function toggleFollow(): void {
    follow = !follow;
    if (follow && pane) pane.scrollTop = pane.scrollHeight;
  }

  // ---------- the station's life (SessionLog has the same rules) ----------
  let clockIn = $state<number | null>(null);
  let powering = $state(false);
  let clocked = false;
  const isStreaming = $derived(streaming(Math.max(lastLiveAt ?? -Infinity, clockIn ?? -Infinity), ticker.now));
  // A refused stream ends dark (idle), never done.
  const lamp = $derived(lampState({ kind: 'stream', ended: ended && !failed, waiting: streamOpen && !isStreaming, streaming: isStreaming }));
  const hot = $derived(isStreaming && settled(ticker.now, S.readyAt));
  $effect(() => {
    if (clocked || !LIVE_LAMPS.has(lamp)) return;
    clocked = true;
    const now = Date.now();
    if (!untrack(() => settled(now, S.readyAt))) return;
    clockIn = now;
    powering = true;
  });
</script>

<svelte:document onvisibilitychange={visibilityChanged} />

<div class="station flex flex-col gap-2 {hot ? 'hot' : ''}" id="environment-log">
  <div class="flex items-center gap-2 min-w-0">
    <span class="nameplate min-w-0"><Lamp state={lamp} /><span class="truncate min-w-0">{$t('environment.log.title', { source: label })}</span>{#if ended}<span class="text-fg">{$t('environment.log.ended')}</span>{/if}</span>
    <span class="ml-auto flex items-center gap-1 shrink-0">
      <IconButton icon="chevron-down" label={$t('environment.log.follow')} hint={follow ? $t('environment.log.pauseHint') : $t('environment.log.followHint')} pressed={follow} onclick={toggleFollow} />
      <CloseButton size="sm" label={$t('environment.log.close')} onclick={onclose} />
    </span>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
  <div
    bind:this={pane}
    onscroll={onScroll}
    onanimationend={(e) => {
      if (e.target === e.currentTarget) powering = false;
    }}
    role="log"
    aria-live="off"
    tabindex="0"
    aria-label={$t('environment.log.aria', { source: label })}
    class="screen mono selectable text-[12px] leading-5 max-h-72 min-h-16 overscroll-contain px-2.5 py-1.5 {LIVE_LAMPS.has(lamp) ? 'live' : ''} {powering ? 'powering' : ''}"
  ><pre class="whitespace-pre-wrap break-words m-0">{#each lines as line}{line}{'\n'}{:else}<span class="text-muted">{failed ? (source === 'dev' ? $t('environment.log.failedDev') : $t('environment.log.failedBacking')) : ended ? $t('environment.log.emptyEnded') : $t('environment.log.waiting')}</span>{/each}</pre></div>
</div>
