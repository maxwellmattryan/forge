<!-- A job's Thread in the drawer: its request and the requests about it with the session's replies. The gate's
     actions and the session's permission prompts live in the drawer's ActionDock, on every tab. Request text and
     results are untrusted: they render only through the escape-first md(), or as plain text in Raw (and above 20k
     characters). The secret scanner's notes (secret-found events) are an ember plate whose masked findings and scan
     error are plain text, never markdown. Progress lines (lib/thread-progress.ts) sit between the messages as one-line rows,
     their agent and engine text plain; the Progress button hides them, and they never count as unread. The opening request
     comes as the server's 2,000-character excerpt; when it was cut, a button loads the whole request.md, which goes
     through the same md() or text view. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import { md } from '../lib/markdown.ts';
  import { renderable } from '../lib/md-view.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { ago, api } from '../lib/util.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { STAGE_LABEL, WAIT_LABEL } from '../lib/labels.ts';
  import { threadFeed, threadProgress, type Progress } from '../lib/thread-progress.ts';
  import { pref } from '../lib/prefs.ts';
  import { requestText, secretLine, threadItems, threadMark, type ThreadAction, type ThreadFrom, type ThreadOpening, type ThreadSecret, type ThreadStatus } from '../lib/thread.ts';
  import { TINT, threadSender } from '../lib/sender.ts';
  import type { ForgeRequest, Job, JobEvent } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  /** `baseline`: the Thread's marks when the drawer opened; a message whose mark is not in it is new or changed since. */
  let { job, requests, opening, events = [], baseline = null }: { job: Job; requests: ForgeRequest[]; opening: ThreadOpening; events?: JobEvent[]; baseline?: string[] | null } = $props();
  const items = $derived(threadItems(requests, opening, events));
  const seenAtOpen = $derived(baseline ? new Set(baseline) : null);
  let showProgress = $state(pref.get('threadProgress', '1') !== '0');
  $effect(() => pref.set('threadProgress', showProgress ? '1' : '0'));
  /** The whole request.md, once loaded, and whether it is shown: both per job, as the drawer reuses this component. */
  let whole = $state<{ job: string; text: string } | null>(null);
  let expanded = $state<string | null>(null);
  let loadingWhole = $state(false);
  const showWhole = $derived(whole !== null && whole.job === job.id && expanded === job.id);

  async function toggleWhole(): Promise<void> {
    if (showWhole) {
      expanded = null;
      return;
    }
    const id = job.id;
    if (whole?.job !== id) {
      loadingWhole = true;
      try {
        whole = { job: id, text: requestText(await api<string>(`/api/jobs/${encodeURIComponent(id)}/file?path=request.md`)) };
      } catch (err) {
        toast($t('thread.wholeFailed', { error: err instanceof Error ? err.message : String(err) }), true);
        return;
      } finally {
        loadingWhole = false;
      }
    }
    expanded = id;
  }

  const rows = $derived(threadFeed(items, showProgress ? threadProgress(events) : []));

  /** A progress line's dot: ok and bad for outcomes, spark where the job waits on a person, gleam for progress. */
  function progressTone(m: Progress): string {
    switch (m.kind) {
      case 'stage':
      case 'pr-opened':
        return 'gleam plain';
      case 'waiting':
        return m.on === 'external' ? 'hollow' : 'spark';
      case 'blocked':
      case 'conflicts':
        return 'warn';
      case 'ended':
        return m.state === 'done' ? 'ok' : m.state === 'failed' ? 'bad' : 'hollow';
      case 'checks':
        return m.ok ? 'ok' : 'bad';
      case 'reviews':
        return m.pass ? 'ok' : 'warn';
      case 'decision':
        return m.approve ? 'ok' : 'spark';
      case 'pr-merged':
        return 'ok';
      default:
        return 'hollow';
    }
  }

  /** A progress line in words; an agent's role and reply, a reason and a note are added beside it as plain text. */
  function progressText(m: Progress): string {
    switch (m.kind) {
      case 'stage':
        return $t('thread.progress.stage', { stage: STAGE_LABEL[m.stage] });
      case 'waiting':
        return m.on ? $t('thread.progress.waiting', { on: WAIT_LABEL[m.on] }) : $t('thread.progress.waitingUnknown');
      case 'blocked':
        return $t('thread.progress.blocked');
      case 'ended':
        return { done: $t('thread.progress.done'), failed: $t('thread.progress.failed'), cancelled: $t('thread.progress.cancelled') }[m.state];
      case 'round':
        return $t('thread.progress.round', { round: m.round });
      case 'agent':
        return $t('thread.progress.agent');
      case 'checks':
        return m.ok ? $t('thread.progress.checksPass', { round: m.round }) : $t('thread.progress.checksFail', { round: m.round });
      case 'reviews':
        return m.pass ? $t('thread.progress.reviewsPass', { round: m.round }) : $t('thread.progress.reviewsFail', { round: m.round });
      case 'decision':
        return m.approve ? $t('thread.progress.approve') : $t('thread.progress.escalate');
      case 'pr-opened':
        return $t('thread.progress.prOpened', { number: m.number });
      case 'pr-merged':
        return $t('thread.progress.prMerged', { number: m.number });
      case 'conflicts':
        return $t('thread.progress.conflicts', { count: m.count });
      case 'note':
        return $t('thread.forge');
    }
  }

  /** The plain text a progress line carries after its words: an agent's reply, a reason or a note. */
  function progressDetail(m: Progress): string | null {
    if (m.kind === 'agent') return m.summary;
    if (m.kind === 'note') return m.text;
    if (m.kind === 'waiting' || m.kind === 'blocked' || m.kind === 'ended' || m.kind === 'decision') return m.reason;
    return null;
  }

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
      <div class="flex items-center gap-1.5"><button type="button" class="btn sm {showProgress ? 'sel' : ''}" aria-pressed={showProgress ? 'true' : 'false'} title={$t('thread.progress.toggleTitle')} onclick={() => (showProgress = !showProgress)}>{$t('thread.progress.toggle')}</button>{#if items.length}<MarkdownToggle surface="thread" />{/if}</div>
    </div>
    {#if rows.length}
      <ol class="flex flex-col gap-2">
        {#each rows as row (row.item.id)}
          {#if row.kind === 'progress'}
            {@const ms = row.item.line}
            {@const detail = progressDetail(ms)}
            <li class="flex items-baseline gap-2 px-3 text-sm">
              <span class="dot {progressTone(ms)} size-1.5 shrink-0 self-center" aria-hidden="true"></span>
              <span class="min-w-0 flex-1 break-words">{#if ms.kind === 'agent'}<span class="text-gleam">{ms.role}</span>{' '}{/if}<span class="text-fg">{progressText(ms)}</span>{#if detail}<span class="selectable text-muted">{' · '}{detail}</span>{/if}</span>
              <span class="shrink-0 text-xs text-muted">{ago(row.item.at, ticker.now)}</span>
            </li>
          {:else}
          {@const m = row.item}
          {#if m.secret}
            <li class="plate ember p-3 flex flex-col gap-1.5 {TINT.forge}">
              <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
                {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="font-semibold text-fg">{who.forge}</span><span class="text-fg">{m.secret.error ? $t('thread.secret.error') : secretText(m.secret)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.secret.blocked}<Chip tone="you" text={$t('thread.secret.blocked')} />{:else}<Chip tone="warn" text={$t('thread.secret.noted')} />{/if}
              </div>
              {#if m.secret.error}<p class="selectable mono text-[12px] break-words">{m.secret.error}</p>{/if}
              {#if m.secret.findings.length}
                <ul class="flex flex-col gap-0.5" aria-label={$t('thread.secret.findings')}>
                  {#each m.secret.findings as f, i (i)}<li class="selectable text-sm font-mono break-all">{secretLine(f)}</li>{/each}
                </ul>
              {/if}
              {#if m.secret.more > 0}<p class="text-sm text-muted">{$t('thread.secret.more', { count: m.secret.more })}</p>{/if}
            </li>
          {:else}
          <li class="plate p-3 flex flex-col gap-1.5 {TINT[threadSender(m.from)]}">
            <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
              {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}<span class="font-semibold text-fg">{who[m.from]}</span><span class="text-fg">{actionText(m.action)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.status}<Chip tone={TONE[m.status]} text={statusText[m.status]} />{/if}
            </div>
            {#if m.text}
              {@const text = m.id === 'request' && showWhole && whole ? whole.text : m.text}
              {#if renderable(text, mdView.thread)}<div class="prose break-words">{@html md(text)}</div>{:else}<p class="selectable text-sm whitespace-pre-wrap break-words">{text}</p>{/if}
              {#if m.id === 'request' && opening.truncated}<button type="button" class="btn sm self-start" aria-expanded={showWhole ? 'true' : 'false'} disabled={loadingWhole} onclick={toggleWhole}>{showWhole ? $t('thread.showLess') : loadingWhole ? $t('thread.loadingWhole') : $t('thread.showWhole')}</button>{/if}
            {/if}
            {#if m.result}
              {#if renderable(m.result, mdView.thread)}
                <div class="{TINT.forge} border-l border-line-strong px-2.5 py-1.5 text-muted"><div class="text-sm font-semibold text-fg">{who.forge}</div><div class="prose break-words">{@html md(m.result)}</div></div>
              {:else}
                <div class="selectable {TINT.forge} border-l border-line-strong px-2.5 py-1.5 text-sm text-muted whitespace-pre-wrap break-words"><span class="font-semibold text-fg">{who.forge}</span> {m.result}</div>
              {/if}
            {/if}
          </li>
          {/if}
          {/if}
        {/each}
      </ol>
    {:else}
      <div class="text-sm text-muted">{$t('thread.empty')}</div>
    {/if}
  </section>
</div>
