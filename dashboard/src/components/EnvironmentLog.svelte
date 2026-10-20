<!-- The Environment card's log viewer: one source (`dev`, or `backing:<name>`) followed live from
     /api/jobs/:id/environment/logs. The stream is open only while this is mounted and the tab is visible. Every line is
     untrusted process output and renders as text. Paused, it keeps the scroll position and still collects lines. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import IconButton from './IconButton.svelte';
  import { atBottom } from '../lib/session-log.ts';
  import { logStreamUrl, parseFrame, pushLines } from '../lib/environment.ts';
  import { forgeToken } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job, source, label, onclose }: { job: string; source: string; label: string; onclose: () => void } = $props();

  let lines = $state.raw<string[]>([]);
  let follow = $state(true);
  let ended = $state(false);
  let pane = $state<HTMLDivElement>();
  let es: EventSource | null = null;

  function open(): void {
    if (es || ended || document.visibilityState !== 'visible') return;
    // A reopened stream starts again from the last lines: drop what it will send again.
    lines = [];
    const s = new EventSource(logStreamUrl(job, source, forgeToken()));
    s.onmessage = (e) => {
      const line = parseFrame(e.data);
      if (line !== null) lines = pushLines(lines, [line]);
    };
    s.addEventListener('end', () => {
      ended = true;
      close();
    });
    es = s;
  }
  function close(): void {
    es?.close();
    es = null;
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

  function onScroll(): void {
    if (pane && follow && !atBottom(pane.scrollHeight, pane.scrollTop, pane.clientHeight)) follow = false;
  }
  function toggleFollow(): void {
    follow = !follow;
    if (follow && pane) pane.scrollTop = pane.scrollHeight;
  }
</script>

<svelte:document onvisibilitychange={visibilityChanged} />

<div class="plate flat flex flex-col gap-2 p-3" id="environment-log">
  <div class="flex items-center gap-2 min-w-0">
    <span class="label truncate min-w-0">{$t('environment.log.title', { source: label })}</span>
    {#if ended}<span class="text-xs text-muted">{$t('environment.log.ended')}</span>{/if}
    <span class="ml-auto flex items-center gap-1 shrink-0">
      <IconButton icon="play" label={$t('environment.log.follow')} hint={follow ? $t('environment.log.pauseHint') : null} pressed={follow} onclick={toggleFollow} />
      <CloseButton size="sm" label={$t('environment.log.close')} onclick={onclose} />
    </span>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
  <div bind:this={pane} onscroll={onScroll} role="log" aria-live="off" tabindex="0" aria-label={$t('environment.log.aria', { source: label })} class="mono selectable text-[12px] leading-5 max-h-72 min-h-16 overflow-y-auto overscroll-contain"><pre class="whitespace-pre-wrap break-words m-0">{#each lines as line}{line}{'\n'}{:else}<span class="text-muted">{ended ? $t('environment.log.emptyEnded') : $t('environment.log.waiting')}</span>{/each}</pre></div>
</div>
