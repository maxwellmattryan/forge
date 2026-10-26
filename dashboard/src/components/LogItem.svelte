<!-- One session log item, as SessionLog and a chat's replies (chats/ChatView.svelte) show it: text, collapsed thinking,
     tool calls with their input and result, sub-agent runs nesting their own items (this component, recursively), and
     every other line kind as one tagged line. Every string is untrusted session output: text and thinking bodies and a
     sub-agent's prompt and result render only through the escape-first md() (as text in Raw, `view`, or above MD_MAX);
     tool input, tool results and every other line render as text. `arrived` says when a call's line arrived live, which
     strikes its gutter. With `cli`, a Bash call to the forge CLI (cliAction) is tagged `forge` and shows its command and
     effect, at any depth. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import Icon from './Icon.svelte';
  import LogItem from './LogItem.svelte';
  import { cliAction } from '../lib/chats.ts';
  import { md } from '../lib/markdown.ts';
  import { renderable } from '../lib/md-view.ts';
  import type { MdView } from '../lib/md-view.ts';
  import { TONE_CLASS, clock } from '../lib/util.ts';
  import type { Item } from '../lib/session-parse.ts';
  import { TINT, logSender } from '../lib/sender.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { struck } from '../lib/station.ts';
  import { t } from '../lib/locale.ts';

  let {
    it,
    compact = false,
    view,
    arrived,
    cli = false,
  }: {
    it: Item;
    compact?: boolean;
    /** Rendered or Raw, from the surface the log belongs to (mdView.session, mdView.chat). */
    view: MdView;
    /** When the line at `offset` arrived live, or null for backlog. */
    arrived: (offset: number) => number | null;
    /** Tag forge CLI calls as CLI actions (a chat's replies). */
    cli?: boolean;
  } = $props();

  const action = $derived(cli ? cliAction(it) : null);
</script>

<!-- Every line is a log-row (style.css): time, caret, tag, body, each in its own column whatever the line's kind, so the
     times, tags and bodies line up down the pane. A line that expands is a log-fold whose open content sits in the body
     column; the summary's one-line preview hides while it is open. -->
{#snippet when(at: string | null)}
  <time datetime={at ?? undefined} title={at ?? undefined} class="log-time">{clock(at)}</time>
{/snippet}

{#snippet caret()}
  <span class="log-caret"><Icon name="chevron-down" /></span>
{/snippet}

{#snippet chip(tone: string | null, tag: string, title: string = tag)}
  <span class="log-tag"><Chip tone={tone && TONE_CLASS[tone] ? tone : 'muted'} extra="max-w-full" {title}><span class="truncate">{tag}</span></Chip></span>
{/snippet}

{#snippet line(at: string | null, tone: string | null, tag: string, text: string)}
  <div class="log-row {TINT.cli} px-1.5 -mx-1.5 py-0.5">{@render when(at)}{@render chip(tone, tag)}<span class="log-body whitespace-pre-wrap break-words">{text}</span></div>
{/snippet}

{#snippet result(r: NonNullable<Extract<Item, { kind: 'tool' }>['result']>)}
  <div class="mt-1">
    <div class="label">{$t('session.result')}</div>
    <pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.preview}</pre>
    {#if r.more}<details class="mt-1"><summary class="text-muted">{$t('session.fullResult')}</summary><pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.full}</pre></details>{/if}
  </div>
{/snippet}

{#if it.kind === 'text'}
  {@const prose = renderable(it.text, view)}
  {@const toneText = it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}
  {#if it.long}
    <details class="log-fold group font-sans {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
      <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-body whitespace-pre-wrap break-words group-open:hidden {toneText}">{it.text.slice(0, 200)}…</span></summary>
      <div class="log-row"><div class="log-body">{#if prose}<div class="{compact ? 'prose compact' : 'prose'} break-words [&>:first-child]:mt-0 {toneText}">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words {toneText}">{it.text}</div>{/if}</div></div>
    </details>
  {:else}
    <div class="log-row font-sans {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">{@render when(it.at)}{#if prose}<div class="log-body {compact ? 'prose compact' : 'prose'} break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0 {toneText}">{@html md(it.text)}</div>{:else}<div class="log-body whitespace-pre-wrap break-words {toneText}">{it.text}</div>{/if}</div>
  {/if}
{:else if it.kind === 'thinking'}
  <details class="log-fold group text-muted {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
    <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-tag"><span>{$t('session.thinkingItem')}</span></span><span class="log-body truncate italic group-open:hidden">{it.text.trim().split('\n', 1)[0]}</span></summary>
    <div class="log-row"><div class="log-body">{#if renderable(it.text, view)}<div class="{compact ? 'prose compact' : 'prose'} font-sans break-words [&>:first-child]:mt-0">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words">{it.text}</div>{/if}</div></div>
  </details>
{:else if it.kind === 'tool'}
  <details class="log-fold {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5 {struck(arrived(it.offset), ticker.now) ? 'strike' : ''}">
    {#if action}
      <!-- A forge CLI call: the command, then its effect (its result's first line) or that it is still running. -->
      <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-tag" title={it.name}><span class={action.isError ? 'text-bad' : 'text-gleam'}>{$t('foreman.chats.cliTag')}</span></span><span class="log-body flex items-baseline gap-2"><span class="min-w-0 truncate" title={action.command}>{action.command}</span>{#if action.effect === null}<span class="shrink-0 text-muted">{$t('foreman.chats.cliRunning')}</span>{:else}<span class="min-w-0 shrink-[3] truncate {action.isError ? 'text-bad' : 'text-muted'}" title={action.effect}>{action.effect}</span>{/if}</span></summary>
    {:else}
      <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-tag" title={it.name}><span class={it.result?.isError ? 'text-bad' : 'text-gleam'}>{it.name}</span></span><span class="log-body flex items-baseline gap-2"><span class="min-w-0 truncate" title={it.summary}>{it.summary}</span>{#if it.task?.text}<span class="min-w-0 shrink-[3] truncate text-muted" title={it.task.text}>{it.task.text}</span>{/if}{#if it.result?.isError}<Chip tone="bad" text={$t('session.error')} extra="shrink-0" />{/if}</span></summary>
    {/if}
    <div class="log-row pb-1"><div class="log-body">
      <div class="label mt-1">{$t('session.input')}</div>
      <pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.input}</pre>
      {#if it.result}{@render result(it.result)}{/if}
    </div></div>
  </details>
{:else if it.kind === 'subagent'}
  <details class="log-fold {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5 {struck(arrived(it.offset), ticker.now) ? 'strike' : ''}">
    <!-- A Forge role drops its plugin prefix so it fits the tag column; the chip's title keeps the full name. -->
    <summary class="log-row">{@render when(it.at)}{@render caret()}{@render chip(it.known ? 'info' : 'muted', it.role.replace(/^forge:/, ''), it.role)}<span class="log-body flex items-baseline gap-2"><span class="min-w-0 truncate" title={it.description}>{it.description}</span>{#if it.task?.text}<span class="min-w-0 shrink-[3] truncate text-muted" title={it.task.text}>{it.task.text}</span>{/if}{#if it.hidden}<span class="shrink-0 text-muted">{$t('session.hiddenLines', { count: it.hidden })}</span>{/if}{#if it.result?.isError}<Chip tone="bad" text={$t('session.error')} extra="shrink-0" />{/if}</span></summary>
    <div class="log-row pb-1">
      {#if it.prompt}
        <details class="log-body mt-1">
          <summary class="text-muted">{$t('session.prompt')}</summary>
          {#if renderable(it.prompt, view)}<div class="prose compact break-words border border-line-soft p-2">{@html md(it.prompt)}</div>{:else}<pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.prompt}</pre>{/if}
        </details>
      {/if}
      {#if it.items.length}<div class="log-nest mt-1 flex flex-col gap-1 border-l border-info/40 pl-2">{#each it.items as child, i (i)}<LogItem it={child} {compact} {view} {arrived} {cli} />{/each}</div>{/if}
      {#if it.result}
        {#if renderable(it.result.full, view)}
          <div class="log-body mt-1"><div class="label">{$t('session.result')}</div><div class="prose compact break-words border border-line-soft p-2 {it.result.isError ? 'text-bad' : ''}">{@html md(it.result.full)}</div></div>
        {:else}<div class="log-body">{@render result(it.result)}</div>{/if}
      {/if}
    </div>
  </details>
{:else if it.kind === 'init'}
  {@render line(it.at, 'muted', 'init', [it.model, it.session].filter(Boolean).join(' · '))}
{:else if it.kind === 'result'}
  {@render line(it.at, it.tone, 'result', it.text)}
{:else if it.kind === 'supervisor'}
  {@render line(it.at, it.tone, 'supervisor', it.text)}
{:else if it.kind === 'task'}
  {@render line(it.at, it.tone, it.role || 'task', it.text)}
{:else}
  {@render line(it.at, it.tone, it.kind, it.text)}
{/if}
