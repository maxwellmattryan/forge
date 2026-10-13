<!-- The daemon bar: pill, Start/Stop/Log and the live log pane. Log lines are untrusted session output and render as text. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Chip from './Chip.svelte';
  import { TONE_CLASS } from '../lib/util.ts';
  import { barModel, lineView, mergeDaemonState, postDaemon } from '../lib/daemon.ts';
  import type { LogEntry } from '../lib/daemon.ts';
  import type { DaemonState } from '../lib/types.ts';
  import { createDaemonLog } from '../lib/daemon-log.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';

  // Follows each new /api/state (assigned only when it changed); SSE frames and POST replies overwrite it in between.
  let daemon = $derived<Partial<DaemonState> | null>(S.data?.daemon ?? null);
  let pending = $state(false);
  const model = $derived(barModel(daemon, { pending }));

  const log = createDaemonLog({
    onState: (st) => (daemon = mergeDaemonState(daemon, st)),
    onChange: () => {
      open = log.open;
      closed = log.closed;
      lines = log.lines.slice();
      note = log.note;
    },
  });
  let open = $state(log.open);
  let closed = $state(false);
  let lines = $state.raw<LogEntry[]>([]);
  let note = $state<string | null>(log.note);
  let pane = $state<HTMLDivElement>();

  $effect(() => {
    const shown = model !== null;
    void open;
    void closed;
    untrack(() => log.sync(shown));
  });
  onDestroy(() => log.dispose());

  // Pinned scroll: a pane at the bottom follows new lines; one scrolled up keeps its place.
  $effect.pre(() => {
    void lines;
    if (!pane) return;
    const p = pane;
    if (p.scrollHeight - p.scrollTop - p.clientHeight <= 24) tick().then(() => (p.scrollTop = p.scrollHeight));
  });
  $effect(() => {
    if (pane) untrack(() => pane && (pane.scrollTop = pane.scrollHeight));
  });

  async function act(action: 'start' | 'stop'): Promise<void> {
    pending = true;
    try {
      const st = await postDaemon(action, forgeToken());
      pending = false;
      daemon = mergeDaemonState(daemon, st);
      refresh();
    } catch (err) {
      pending = false;
      toast(`Daemon ${action} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
</script>

<svelte:document onvisibilitychange={() => log.visibilityChanged()} />

<!-- No whitespace inside #daemon or the pane: the wrapper relies on :empty, and the pane is whitespace-pre-wrap. -->
<div id="daemon" class="mx-auto max-w-[1400px] px-4 md:px-8 pt-6 empty:hidden">{#if model}<div class="card px-4 py-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="chip {TONE_CLASS[model.pill.tone]}" title={model.pill.title}>Daemon {model.pill.label}</span>
        {#if model.held !== null}<span class="chip {TONE_CLASS.warn}" title={model.held}>held: budget</span>{/if}
        {#if model.error !== null}<span class="truncate min-w-0 flex-1 text-xs text-muted" title={model.error}>{model.error}</span>{:else}<span class="flex-1"></span>{/if}
        <span class="flex items-center gap-2">
          <button class="btn text-xs" disabled={!model.canStart} title={model.startHint} onclick={() => act('start')}>Start</button>
          <button class="btn text-xs" disabled={!model.canStop} onclick={() => act('stop')}>Stop</button>
          <button class="btn text-xs" aria-expanded={open ? 'true' : 'false'} onclick={() => log.toggle()}>Log</button>
        </span>
      </div>
      {#if open}
        <div bind:this={pane} class="mt-2 max-h-72 overflow-y-auto rounded-lg bg-raised p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">{#each lines as e (e.seq)}{@const v = lineView(e.line)}<div class="flex items-start gap-2">{#if v.tone && TONE_CLASS[v.tone]}<Chip tone={v.tone} text={v.tag} extra="shrink-0" />{:else}<span class="chip shrink-0 text-muted">{v.tag}</span>{/if}<span class="min-w-0">{v.text}</span></div>{/each}{#if note !== null}<div class="text-muted">{note}</div>{/if}</div>
      {/if}
    </div>{/if}</div>
