<!-- The command bar (Cmd/Ctrl-K): a modal ARIA combobox that starts a job from free text or sends a /forge-style command.
     A centred sheet at md and up, a full-width sheet at the top below. lib/command.ts holds the grammar and mapping. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import StateChip from './StateChip.svelte';
  import { S, createJob, loadBacklog, openDrawer, postRequest, refresh } from '../lib/app.svelte.ts';
  import { commandQueuedMessage, commandRequest, createdMessage, emptyReason, parseCommand, suggest, type CommandCtx, type Suggestion, type Verb } from '../lib/command.ts';
  import { buildRequest } from '../lib/view.ts';
  import { wrapFocus } from '../lib/settings.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { onclose }: { onclose: () => void } = $props();

  let text = $state('');
  let title = $state('');
  let active = $state(0);
  let pending = $state(false);
  let error = $state<string | null>(null);
  let dialog = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();
  let pressedOnBackdrop = false;

  const ctx = $derived<CommandCtx>({ jobs: S.data?.jobs ?? [], backlog: S.backlog ? S.backlog.items : null, tracker: S.data?.config?.tracker ?? 'none' });
  const parsed = $derived(parseCommand(text, ctx));
  const options = $derived(suggest(text, ctx));
  const isFree = $derived(parsed.kind === 'free');
  const canRun = $derived(parsed.kind !== 'empty' && parsed.kind !== 'partial');
  const empty = $derived(emptyReason(parsed, options, S.backlog?.error, ctx));
  const emptyText = $derived(
    empty === null
      ? null
      : empty === 'noJobs'
        ? $t('command.noJobs')
        : empty === 'noItems'
          ? $t('command.noItems')
          : empty === 'backlogLoading'
            ? $t('command.backlogLoading')
            : $t('command.backlogFailed', { error: S.backlog?.error ?? '' }),
  );

  const hints = $derived<Record<Verb, string>>({
    next: $t('command.hints.next'),
    issue: $t('command.hints.issue'),
    continue: $t('command.hints.continue'),
    approve: $t('command.hints.approve'),
    answer: $t('command.hints.answer'),
    revise: $t('command.hints.revise'),
    rework: $t('command.hints.rework'),
    cancel: $t('command.hints.cancel'),
    sync: $t('command.hints.sync'),
    retro: $t('command.hints.retro'),
  });

  // A new input starts at the first option again, and a list that shrank under it (the backlog finished
  // loading) never leaves `active` past its end, where Enter would run without a chosen option.
  $effect(() => {
    void text;
    active = 0;
  });
  $effect(() => {
    if (active >= options.length) active = 0;
  });
  // Arrow keys keep the active option on screen, even on a short viewport.
  $effect(() => {
    if (options.length) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  const optionId = (i: number): string => `command-opt-${i}`;

  function insert(s: string): void {
    text = s;
    error = null;
    tick().then(() => {
      input?.focus();
      input?.setSelectionRange(s.length, s.length);
    });
  }

  function activate(o: Suggestion | undefined): void {
    if (!o) return void submit();
    if (o.kind === 'run-job' || o.kind === 'run-command') submit();
    else insert(o.insert);
  }

  function inputKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const n = options.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    } else if (e.key === 'Tab' && !e.shiftKey) {
      const o = options[active];
      if (o && o.kind !== 'run-job' && o.kind !== 'run-command') {
        e.preventDefault();
        insert(o.insert);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(options[active]);
    }
  }

  function titleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function submit(): Promise<void> {
    if (pending) return;
    const r = commandRequest(parsed);
    if ('error' in r) {
      error = r.error;
      return;
    }
    pending = true;
    error = null;
    try {
      if (r.kind === 'job') {
        const res = await createJob({ ...r.body, ...(title.trim() ? { title: title.trim() } : {}) });
        onclose();
        toast(createdMessage(res.id, res.daemon));
        await refresh();
        openDrawer(res.id, null, 'thread');
      } else {
        const built = buildRequest(r.input);
        if ('error' in built) throw new Error(built.error);
        const res = await postRequest(built.body);
        onclose();
        toast(commandQueuedMessage(built.body.type, built.body.job, res.daemon));
        refresh();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      pending = false;
    }
  }

  const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trap(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.defaultPrevented || !dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
    const i = wrapFocus(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (i === null) return;
    e.preventDefault();
    items[i].focus();
  }

  // Both ends of the click must be on the backdrop, so a text selection dragged out of the dialog doesn't close it.
  function backdropDown(e: MouseEvent): void {
    pressedOnBackdrop = e.target === e.currentTarget;
  }

  function backdrop(e: MouseEvent): void {
    const both = pressedOnBackdrop && e.target === e.currentTarget;
    pressedOnBackdrop = false;
    if (both) onclose();
  }

  /** Focuses the input: called when the bar opens, and again when the shortcut is pressed while it is open. */
  export function focus(): void {
    input?.focus();
  }

  onMount(() => {
    if (!S.backlog) loadBacklog();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    tick().then(() => input?.focus());
    return () => {
      document.body.style.overflow = overflow;
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop; Escape closes the dialog from the keyboard) -->
<div class="fixed inset-0 z-45 flex items-start justify-center backdrop md:p-6 md:pt-[12vh]" onmousedown={backdropDown} onclick={backdrop}>
  <div bind:this={dialog} role="dialog" aria-modal="true" aria-label={$t('command.title')} tabindex="-1" class="sheet ticks solid flex flex-col w-full min-w-0 max-h-[85vh] shadow-(--shadow-dialog) md:max-w-[672px]" onkeydown={trap}>
    <span class="tk"></span>
    <div class="flex items-center gap-2 border-b border-line px-3">
      <Icon name="command" class="shrink-0 text-muted" />
      <input
        bind:this={input}
        bind:value={text}
        id="command-input"
        type="text"
        role="combobox"
        aria-label={$t('command.label')}
        aria-expanded={options.length > 0}
        aria-controls="command-list"
        aria-autocomplete="list"
        aria-activedescendant={options.length ? optionId(active) : undefined}
        autocomplete="off"
        spellcheck="false"
        placeholder={$t('command.placeholder')}
        class="flex-1 min-w-0 my-2 text-[15px]"
        onkeydown={inputKey}
        oninput={() => (error = null)}
      />
      <button class="btn icon touch shrink-0 md:hidden" aria-label={$t('command.close')} onclick={onclose}><Icon name="close" /></button>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events (options are chosen from the keyboard through the combobox: arrows, Tab and Enter) -->
    <ul id="command-list" role="listbox" aria-label={$t('command.suggestions')} class="flex-1 min-h-0 overflow-y-auto p-1.5 {options.length ? '' : 'hidden'}">
      {#each options as o, i (i)}
        <li
          id={optionId(i)}
          role="option"
          aria-selected={i === active}
          class="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer {i === active ? 'bg-raised text-fg shadow-[inset_3px_0_0_var(--ink)]' : 'text-muted'}"
          onmousemove={() => (active = i)}
          onclick={() => activate(o)}
        >
          {#if o.kind === 'run-job'}
            <Icon name="command" class="shrink-0 text-ink" /><span class="font-medium text-fg shrink-0">{$t('command.start')}</span><span class="flex min-w-0 flex-col"><span class="truncate">{text.trim()}</span>{#if o.verbLike}<span class="text-xs text-muted">{$t('command.verbLike')}</span>{/if}</span>
          {:else if o.kind === 'run-command'}
            <Icon name="command" class="shrink-0 text-ink" /><span class="font-medium text-fg shrink-0">{$t('command.send')}</span><span class="truncate min-w-0 font-mono">{text.trim()}</span>
          {:else if o.kind === 'verb'}
            <span class="font-mono text-fg shrink-0 w-16">{o.verb}</span><span class="truncate min-w-0">{hints[o.verb]}</span>
          {:else if o.kind === 'job'}
            <span class="font-mono text-fg truncate min-w-0 flex-1 sm:flex-none sm:shrink-0 sm:max-w-[45%]">{o.job.id}</span><span class="hidden sm:inline truncate min-w-0 flex-1">{o.job.title}</span><StateChip job={o.job} />
          {:else}
            <span class="font-mono text-fg shrink-0">{o.item.ref}</span><span class="truncate min-w-0">{o.item.title}</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if emptyText}<p class="px-4 py-3 text-sm text-muted" aria-hidden="true">{emptyText}</p>{/if}
    <!-- The visible reason is announced here, so a screen reader hears "Loading the backlog…", not just "No suggestions". -->
    <div class="sr-only" aria-live="polite">{options.length ? $t('command.count', { count: options.length }) : (emptyText ?? $t('command.empty'))}</div>
    {#if isFree}
      <div class="flex flex-col gap-1 border-t border-line px-4 py-3">
        <label for="command-title" class="text-[11px] text-muted">{$t('command.titleLabel')}</label>
        <input id="command-title" type="text" bind:value={title} maxlength="120" autocomplete="off" placeholder={$t('command.titlePlaceholder')} class="w-full" onkeydown={titleKey} />
      </div>
    {/if}
    {#if error}<div role="alert" class="border-t border-line bg-panel px-4 py-2 text-sm text-bad">{error}</div>{/if}
    <div class="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
      <button class="btn primary" disabled={pending || !canRun} onclick={submit}>{pending ? $t('command.working') : isFree ? $t('command.start') : canRun ? $t('command.send') : $t('command.run')}</button>
    </div>
  </div>
</div>
