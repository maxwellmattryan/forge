<!-- A job's Thread in the drawer: its request and the requests about it with the session's replies. The gate's
     actions and the session's permission prompts live in the drawer's ActionDock, on every tab. Request text and
     results are untrusted: they render only through the escape-first md(), or as plain text in Raw (and above 20k
     characters). The secret scanner's notes (secret-found events) are an ember plate whose masked findings and scan
     error are plain text, never markdown. Progress lines (lib/thread-progress.ts) sit between the messages as one-line rows,
     their agent and engine text plain; the Progress button hides them, and they never count as unread. The opening request
     comes as the server's 2,000-character excerpt; when it was cut, a button loads the whole request.md, which goes
     through the same md() or text view. Each sender has its own colour and icon (lib/sender.ts WHO), the same on every
     message. A message or reply that arrives while the Thread is open types out behind a caret (lib/typing.ts), its
     reply after it; what was there when it opened, a page load or a reconnect (settled()) and reduced motion show whole. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import Chip from './Chip.svelte';
  import Icon from './Icon.svelte';
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
  import { WHO } from '../lib/sender.ts';
  import { S } from '../lib/app.svelte.ts';
  import { prefersReducedMotion, settled } from '../lib/motion.ts';
  import { scheduleTyping, typedText, type Typing } from '../lib/typing.ts';
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

  // ---------- typing ----------
  /** Every message part with text, `<id>:text` then `<id>:result`, in the conversation's order. */
  const parts = $derived(new Map(items.flatMap((m) => [...(m.text ? [[`${m.id}:text`, m.text] as const] : []), ...(m.result ? [[`${m.id}:result`, m.result] as const] : [])])));
  /** The parts this job's Thread has shown: only one it hasn't types. */
  let seen: { job: string; keys: Set<string> } | null = null;
  let typing = $state<Record<string, Typing>>({});
  let now = $state(Date.now());
  $effect(() => {
    const all = parts;
    const id = job.id;
    untrack(() => {
      if (seen?.job !== id) {
        seen = { job: id, keys: new Set(all.keys()) };
        typing = {};
        return;
      }
      const fresh = [...all.keys()].filter((k) => !seen!.keys.has(k));
      for (const k of fresh) seen.keys.add(k);
      const at = Date.now();
      if (!fresh.length || prefersReducedMotion() || !settled(at, S.readyAt)) return;
      now = at;
      typing = { ...typing, ...scheduleTyping(all, fresh, at) };
    });
  });
  // One frame loop while anything types; a part leaves `typing` once it is whole.
  $effect(() => {
    if (!Object.keys(typing).length) return;
    let raf = requestAnimationFrame(function step(): void {
      const at = Date.now();
      now = at;
      const left = Object.entries(typing).filter(([, p]) => at < p.start + p.ms);
      if (left.length < Object.keys(typing).length) typing = Object.fromEntries(left);
      else raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  });
  /** A part as it shows now: `typing` while the caret is on it, null before its turn to type. */
  function typed(id: string, which: 'text' | 'result', full: string): { text: string; typing: boolean } | null {
    const p = typing[`${id}:${which}`];
    if (!p) return { text: full, typing: false };
    const text = typedText(full, p, now);
    return now < p.start ? null : { text, typing: true };
  }

  /** A progress line's dot: ok and bad for outcomes, spark where the job waits on a person, gleam for progress. */
  function progressTone(m: Progress): string {
    switch (m.kind) {
      case 'stage':
      case 'pr-opened':
      case 'ci-rerun':
        return 'gleam plain';
      case 'ci-rerun-failed':
        return 'spark';
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
      case 'ci-rerun':
        return $t('thread.progress.ciRerun');
      case 'ci-rerun-failed':
        return m.reran ? $t('thread.progress.ciRerunFailed') : $t('thread.progress.ciRerunRefused');
      case 'note':
        return $t('thread.forge');
    }
  }

  /** The plain text a progress line carries after its words: an agent's reply, a reason or a note. */
  function progressDetail(m: Progress): string | null {
    if (m.kind === 'agent') return m.summary;
    if (m.kind === 'note') return m.text;
    if (m.kind === 'waiting' || m.kind === 'blocked' || m.kind === 'ended' || m.kind === 'decision') return m.reason;
    if (m.kind === 'ci-rerun' || m.kind === 'ci-rerun-failed') return m.checks.length ? m.checks.join(', ') : null;
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

<!-- A sender's mark and name, in its colour (the enclosing `who` sets it). The name is the cue; the icon repeats it. -->
{#snippet sender(from: ThreadFrom)}
  <span class="who-mark" aria-hidden="true"><Icon name={WHO[from].icon} /></span><span class="who-name">{who[from]}</span>
{/snippet}
<!-- A part's text, rendered or plain, with the caret after it while it types. -->
{#snippet body(part: { text: string; typing: boolean }, size: string)}
  {#if renderable(part.text, mdView.thread)}<div class="prose break-words {part.typing ? 'caret' : ''}">{@html md(part.text)}</div>{:else}<p class="selectable {size} whitespace-pre-wrap break-words {part.typing ? 'caret' : ''}">{part.text}</p>{/if}
{/snippet}

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
            <li class="plate ember {WHO.forge.cls} p-3 flex flex-col gap-1.5">
              <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
                {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}{@render sender('forge')}<span class="text-fg">{m.secret.error ? $t('thread.secret.error') : secretText(m.secret)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.secret.blocked}<Chip tone="you" text={$t('thread.secret.blocked')} />{:else}<Chip tone="warn" text={$t('thread.secret.noted')} />{/if}
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
          <li class="plate {WHO[m.from].cls} p-3 flex flex-col gap-1.5">
            <div class="caption flex flex-wrap items-center gap-x-2 gap-y-1">
              {#if seenAtOpen && !seenAtOpen.has(threadMark(m))}<span class="dot spark size-1.5 shrink-0" aria-hidden="true"></span><span class="sr-only">{$t('live.new')}</span>{/if}{@render sender(m.from)}<span class="text-fg">{actionText(m.action)}</span>{#if m.at}<span class="text-muted">{ago(m.at, ticker.now)}</span>{/if}<span class="flex-1"></span>{#if m.status}<Chip tone={TONE[m.status]} text={statusText[m.status]} />{/if}
            </div>
            {#if m.text}
              {@const shown = typed(m.id, 'text', m.id === 'request' && showWhole && whole ? whole.text : m.text)}
              {#if shown}{@render body(shown, 'text-sm')}{/if}
              {#if m.id === 'request' && opening.truncated}<button type="button" class="btn sm self-start" aria-expanded={showWhole ? 'true' : 'false'} disabled={loadingWhole} onclick={toggleWhole}>{showWhole ? $t('thread.showLess') : loadingWhole ? $t('thread.loadingWhole') : $t('thread.showWhole')}</button>{/if}
            {/if}
            {#if m.result}
              {@const reply = typed(m.id, 'result', m.result)}
              {#if reply}
                <div class="{WHO.forge.cls} reply flex flex-col gap-1 px-2.5 py-1.5 text-muted"><div class="caption flex items-center gap-2">{@render sender('forge')}</div>{@render body(reply, 'text-sm')}</div>
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
