<!-- The GitHub hover card: any link to a github.com repository, pull request, issue or commit, anywhere in the dashboard
     (markdown included), shows one after a resting pointer or keyboard focus. It listens on the document, so no link
     opts in. The card is a tooltip the link describes: the link stays the keyboard's way to GitHub, and the card's own
     links are for the pointer. Everything in it is GitHub text and renders as text. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { CARD_ID, closeCard, ghCard, holdCard, isCardLink, linkIntent, pointerLeft } from '../lib/github-card.svelte.ts';
  import { checksTone, countShort, placeCard, previewable, reviewTone, stateTone } from '../lib/github.ts';
  import { ago } from '../lib/util.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { t } from '../lib/locale.ts';

  let card = $state<HTMLDivElement>();
  let height = $state(0);
  // Bumped on scroll and resize, so the card follows its link (a streaming session log scrolls under it all the time).
  let frame = $state(0);

  const preview = $derived(ghCard.result && 'preview' in ghCard.result ? ghCard.result.preview : null);
  const failure = $derived(ghCard.result && 'error' in ghCard.result ? ghCard.result : null);
  // Before the answer: the kind and repo the URL names. /issues/N may turn out to be a pull request.
  const path = $derived(ghCard.url.replace(/^https:\/\/github\.com\//, ''));
  const kind = $derived(preview?.kind ?? (path.includes('/pull/') ? 'pull' : path.includes('/issues/') ? 'issue' : path.includes('/commit/') ? 'commit' : 'repo'));
  const repo = $derived(preview?.repo ?? path.split('/').slice(0, 2).join('/'));
  // GitHub's own url when it is a github.com page, else the one the link named.
  const href = $derived(safeUrl(preview && previewable(preview.url) ? preview.url : ghCard.url));
  const tone = $derived(preview ? stateTone(preview) : null);

  const place = $derived.by(() => {
    void frame;
    const r = ghCard.link?.getBoundingClientRect() ?? { left: 0, top: 0, bottom: 0 };
    return placeCard({ rect: r, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight, height });
  });

  const KIND = $derived({ pull: $t('github.kind.pull'), issue: $t('github.kind.issue'), repo: $t('github.kind.repo'), commit: $t('github.kind.commit') });
  const STATE = $derived<Record<string, string>>({
    open: $t('github.state.open'),
    draft: $t('github.state.draft'),
    merged: $t('github.state.merged'),
    closed: $t('github.state.closed'),
    not_planned: $t('github.state.notPlanned'),
    duplicate: $t('github.state.duplicate'),
  });
  const CHECKS = $derived({ success: $t('github.checks.success'), failure: $t('github.checks.failure'), pending: $t('github.checks.pending') });
  const REVIEW = $derived({ approved: $t('github.review.approved'), changes_requested: $t('github.review.changesRequested'), review_required: $t('github.review.required') });

  const linkOf = (target: EventTarget | null): HTMLAnchorElement | null => (target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null);
  const inCard = (n: EventTarget | null): boolean => n instanceof Node && Boolean(card?.contains(n));

  // Mouse only: a tap on a phone opens the link, and a pen hovering over one is not asking for a card.
  function over(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (inCard(e.target)) return holdCard();
    const a = linkOf(e.target);
    const url = a && previewable(a.href);
    if (a && url) linkIntent(a, url);
  }

  function out(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' || !(e.target instanceof Node)) return;
    pointerLeft(e.target, e.relatedTarget instanceof Node ? e.relatedTarget : null, card ?? null);
  }

  // Keyboard focus only (:focus-visible): a click focuses the link too, and that click is already leaving for GitHub.
  function focusIn(e: FocusEvent): void {
    if (inCard(e.target)) return;
    const a = linkOf(e.target);
    const url = a && previewable(a.href);
    if (a && url && a.matches(':focus-visible')) return linkIntent(a, url);
    if (!isCardLink(a)) closeCard();
  }

  function down(e: PointerEvent): void {
    if (!inCard(e.target) && !isCardLink(linkOf(e.target))) closeCard();
  }

  const follow = (): number => frame++;

  $effect(() => {
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('scroll', follow, true);
      closeCard();
    };
  });

  // A re-render that drops the link (a job leaving the board, the drawer closing) takes the card with it.
  $effect(() => {
    const link = ghCard.link;
    if (!link) return;
    const check = setInterval(() => !link.isConnected && closeCard(), 500);
    return () => clearInterval(check);
  });
</script>

<svelte:window onresize={follow} />

{#if ghCard.link}
  <div
    bind:this={card}
    bind:offsetHeight={height}
    id={CARD_ID}
    role="tooltip"
    class="sheet ticks solid fixed z-55 flex flex-col gap-2 p-3 text-sm shadow-(--shadow-dialog)"
    style="top: {place.top}px; left: {place.left}px; width: {place.width}px"
    onpointerenter={holdCard}
    onpointerleave={(e) => e.pointerType === 'mouse' && card && pointerLeft(card, e.relatedTarget instanceof Node ? e.relatedTarget : null, card)}
  >
    <span class="tk"></span>
    <div class="flex min-w-0 items-center gap-2">
      <span class="label min-w-0 flex-1 truncate">{KIND[kind]} · {repo}</span>
      {#if preview && tone && 'state' in preview}<Chip {tone} text={STATE[preview.state]} extra="shrink-0" />{:else if preview?.kind === 'repo' && preview.archived}<Chip tone="warn" text={$t('github.repo.archived')} extra="shrink-0" />{/if}
    </div>

    {#if failure}
      <p class="muted">{#if failure.error === 'gh_missing'}{$t('github.error.ghMissing')}{:else if failure.error === 'not_found'}{$t('github.error.notFound')}{:else}{$t('github.error.failed', { message: failure.message })}{/if}</p>
    {:else if !preview}
      <p class="muted">{$t('common.loading')}</p>
    {:else if preview.kind === 'pull' || preview.kind === 'issue'}
      <a class="h card text-ink line-clamp-2 break-words hover:underline" {href} target="_blank" rel="noopener noreferrer" tabindex="-1">{preview.title} <span class="mono muted font-normal">#{preview.number}</span></a>
      {#if preview.excerpt}<p class="muted line-clamp-3 break-words">{preview.excerpt}</p>{/if}
      {#if preview.kind === 'pull'}<div class="mono muted truncate" title="{preview.base} ← {preview.head}">{preview.base} ← {preview.head}</div>{/if}
      {#if (preview.kind === 'pull' && (preview.checks || preview.review)) || preview.labels.length}
        <div class="flex flex-wrap gap-1.5">
          {#if preview.kind === 'pull' && preview.checks}<Chip tone={checksTone(preview.checks)} text={CHECKS[preview.checks]} />{/if}
          {#if preview.kind === 'pull' && preview.review}<Chip tone={reviewTone(preview.review)} text={REVIEW[preview.review]} />{/if}
          {#each preview.labels as label (label)}<Chip tone="muted" text={label} extra="max-w-full truncate" />{/each}
        </div>
      {/if}
      <div class="caption muted flex flex-wrap gap-x-3 gap-y-0.5">
        {#if preview.kind === 'pull'}<span class="num"><span class="text-ok">+{countShort(preview.additions)}</span> <span class="text-bad">−{countShort(preview.deletions)}</span></span><span>{$t('github.facts.files', { count: preview.changedFiles, n: countShort(preview.changedFiles) })}</span>{/if}
        <span>{$t('github.facts.comments', { count: preview.comments, n: countShort(preview.comments) })}</span>
        <span>{preview.author ? $t('github.facts.openedBy', { author: preview.author, ago: ago(preview.createdAt, ticker.now) }) : $t('github.facts.opened', { ago: ago(preview.createdAt, ticker.now) })}</span>
        {#if preview.kind === 'issue' && preview.assignees.length}<span>{$t('github.facts.assigned', { names: preview.assignees.join(', ') })}</span>{/if}
      </div>
    {:else if preview.kind === 'repo'}
      <a class="h card text-ink truncate hover:underline" {href} target="_blank" rel="noopener noreferrer" tabindex="-1">{preview.repo}</a>
      {#if preview.description}<p class="muted line-clamp-3 break-words">{preview.description}</p>{/if}
      {#if preview.private || preview.fork || preview.language || preview.license}
        <div class="flex flex-wrap gap-1.5">
          {#if preview.private}<Chip tone="muted" text={$t('github.repo.private')} />{/if}
          {#if preview.fork}<Chip tone="muted" text={$t('github.repo.fork')} />{/if}
          {#if preview.language}<Chip tone="info" text={preview.language} />{/if}
          {#if preview.license}<Chip tone="muted" text={preview.license} />{/if}
        </div>
      {/if}
      <div class="caption muted flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{$t('github.facts.stars', { count: preview.stars, n: countShort(preview.stars) })}</span>
        <span>{$t('github.facts.forks', { count: preview.forks, n: countShort(preview.forks) })}</span>
        <span>{$t('github.facts.openIssues', { count: preview.openIssues, n: countShort(preview.openIssues) })}</span>
        <span>{$t('github.facts.openPulls', { count: preview.openPulls, n: countShort(preview.openPulls) })}</span>
        {#if preview.pushedAt}<span>{$t('github.facts.pushed', { ago: ago(preview.pushedAt, ticker.now) })}</span>{/if}
      </div>
    {:else}
      <a class="h card text-ink line-clamp-2 break-words hover:underline" {href} target="_blank" rel="noopener noreferrer" tabindex="-1">{preview.headline}</a>
      {#if preview.checks}<div class="flex flex-wrap gap-1.5"><Chip tone={checksTone(preview.checks)} text={CHECKS[preview.checks]} /></div>{/if}
      <div class="caption muted flex flex-wrap gap-x-3 gap-y-0.5">
        <span class="mono">{preview.sha.slice(0, 7)}</span>
        <span class="num"><span class="text-ok">+{countShort(preview.additions)}</span> <span class="text-bad">−{countShort(preview.deletions)}</span></span>
        <span>{preview.author ? $t('github.facts.committedBy', { author: preview.author, ago: ago(preview.committedAt, ticker.now) }) : $t('github.facts.committed', { ago: ago(preview.committedAt, ticker.now) })}</span>
      </div>
    {/if}

    <div class="flex items-center justify-between gap-2 border-t border-line pt-2">
      <span class="mono muted min-w-0 truncate text-[11px]">{path}</span>
      <a class="btn sm shrink-0" {href} target="_blank" rel="noopener noreferrer" tabindex="-1">{$t('github.open')}</a>
    </div>
  </div>
{/if}
