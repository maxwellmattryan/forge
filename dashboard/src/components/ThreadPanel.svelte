<!-- A job's Thread in the drawer: its request and the requests about it with the session's replies. The gate's
     actions and the session's permission prompts live in the drawer's ActionDock, on every tab. Request text and
     results are untrusted: they render only through the escape-first md(), or as plain text in Raw (and above 20k
     characters). The secret scanner's notes (secret-found events) are an ember plate whose masked findings are plain
     text, never markdown. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import { md } from '../lib/markdown.ts';
  import { renderable } from '../lib/md-view.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { ago } from '../lib/util.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { secretLine, threadItems, threadMark, type ThreadAction, type ThreadFrom, type ThreadOpening, type ThreadSecret, type ThreadStatus } from '../lib/thread.ts';
  import type { ForgeRequest, Job, JobEvent } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  /** `baseline`: the Thread's marks when the drawer opened; a message whose mark is not in it is new or changed since. */
  let { job, requests, opening, events = [], baseline = null }: { job: Job; requests: ForgeRequest[]; opening: ThreadOpening; events?: JobEvent[]; baseline?: string[] | null } = $props();
  const items = $derived(threadItems(requests, opening, events));
  const seenAtOpen = $derived(baseline ? new Set(baseline) : null);

  const who = $derived<Record<ThreadFrom, string>>({ you: $t('thread.you'), cli: $t('thread.cli'), forge: $t('thread.forge'), tracker: $t('thread.tracker') });
  const statusText = $derived<Record<ThreadStatus, string>>({ queued: $t('thread.queued'), handling: $t('thread.handling'), done: $t('thread.done'), rejected: $t('thread.rejected') });
  const TONE: Record<ThreadStatus, string> = { queued: 'muted', handling: 'live', done: 'ok', rejected: 'bad' };

  /** What the scanner found and where, in words: "2 possible secrets in builder's output". */
  function secretText(n: ThreadSecret): string {
    const count = n.count;
    switch (n.gate) {
      case 'verify':
        return $t('thread.secret.verify', { count });
      case 'commit':
        return $t('thread.secret.commit', { count });
      case 'pr':
        return $t('thread.secret.pr', { count });
      case 'agent-end':
        return $t('thread.secret.agentEnd', { count, role: n.role ?? $t('thread.secret.anAgent') });
      default:
        return $t('thread.secret.elsewhere', { count });
    }
  }

  /** What a message asks for, in words: never the raw request type. */
  function actionText(a: ThreadAction): string {
    switch (a.kind) {
      case 'request':
        return $t('thread.action.request');
      case 'imported':
        return $t('thread.action.imported');
      case 'started':
        return $t('thread.action.started');
      case 'handoff':
        return $t('thread.action.handoff');
      case 'resumed':
        return $t('thread.action.resumed');
      case 'link':
        return $t('thread.action.link', { ref: a.ref });
      case 'link-new':
        return $t('thread.action.linkNew');
      case 'link-none':
        return $t('thread.action.linkNone');
      case 'next':
        return $t('thread.action.next', { count: a.n });
      case 'run':
        return $t('thread.action.run', { ref: a.ref });
      // Notes render their own caption (secretText); this keeps the switch total.
      case 'secret':
        return $t('thread.forge');
      default:
        return {
          approve: $t('thread.action.approve'),
          revise: $t('thread.action.revise'),
          rework: $t('thread.action.rework'),
          answer: $t('thread.action.answer'),
          cancel: $t('thread.action.cancel'),
          sync: $t('thread.action.sync'),
          eval: $t('thread.action.eval'),
          retro: $t('thread.action.retro'),
        }[a.verb];
    }
  }
</script>

<div class="flex flex-col gap-5">
  <section class="flex flex-col gap-2" aria-labelledby="thread-conversation-{job.id}">
    <div class="flex items-center justify-between gap-2">
      <h3 id="thread-conversation-{job.id}" class="label callout">{$t('thread.conversation')}</h3>
      {#if items.length}<MarkdownToggle surface="thread" />{/if}
    </div>
    {#if items.length}
      <ol class="flex flex-col gap-2">
        {#each items as m (m.id)}
          {#if m.secret}
            <li class="plate ember p-3 flex flex-col gap-1.5">
              <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
                {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="font-medium text-fg">{who.forge}</span><span class="text-fg">{secretText(m.secret)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.secret.blocked}<Chip tone="you" text={$t('thread.secret.blocked')} />{:else}<Chip tone="warn" text={$t('thread.secret.noted')} />{/if}
              </div>
              {#if m.secret.findings.length}
                <ul class="flex flex-col gap-0.5" aria-label={$t('thread.secret.findings')}>
                  {#each m.secret.findings as f, i (i)}<li class="text-sm font-mono break-all">{secretLine(f)}</li>{/each}
                </ul>
              {/if}
              {#if m.secret.more > 0}<p class="text-sm text-muted">{$t('thread.secret.more', { count: m.secret.more })}</p>{/if}
            </li>
          {:else}
          <li class="plate p-3 flex flex-col gap-1.5">
            <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
              {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="font-medium text-fg">{who[m.from]}</span><span class="text-fg">{actionText(m.action)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.status}<Chip tone={TONE[m.status]} text={statusText[m.status]} />{/if}
            </div>
            {#if m.text}
              {#if renderable(m.text, mdView.thread)}<div class="prose compact break-words">{@html md(m.text)}</div>{:else}<p class="text-sm whitespace-pre-wrap break-words">{m.text}</p>{/if}
            {/if}
            {#if m.result}
              {#if renderable(m.result, mdView.thread)}
                <div class="border-l border-line-strong pl-2.5 text-muted"><div class="text-xs font-medium text-fg">{who.forge}</div><div class="prose compact break-words">{@html md(m.result)}</div></div>
              {:else}
                <div class="border-l border-line-strong pl-2.5 text-sm text-muted whitespace-pre-wrap break-words"><span class="text-xs font-medium text-fg">{who.forge}</span> {m.result}</div>
              {/if}
            {/if}
          </li>
          {/if}
        {/each}
      </ol>
    {:else}
      <div class="text-sm text-muted">{$t('thread.empty')}</div>
    {/if}
  </section>
</div>
