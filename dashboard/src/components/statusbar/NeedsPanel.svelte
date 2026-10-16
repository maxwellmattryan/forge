<!-- The Needs-you popover's body (the page it replaced): every pending permission prompt in the pool, answered right here,
     then decisions only a human can make, PRs awaiting review, jobs parked on their dependencies (listed apart: they resume by themselves, but a human may unblock one), and queued requests.
     Opening a job opens its pane, and StatusBar closes the popover. Titles, reasons and request text are untrusted and
     render as text; the PR link goes through safeUrl. -->
<script lang="ts">
  import DepChips from '../DepChips.svelte';
  import Icon from '../Icon.svelte';
  import InboxCard from '../InboxCard.svelte';
  import JobActions from '../JobActions.svelte';
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import PrChip from '../PrChip.svelte';
  import { safeUrl } from '../../lib/markdown.ts';
  import { ago } from '../../lib/util.ts';
  import type { ApiState } from '../../lib/types.ts';
  import { cardRef, inboxGroups } from '../../lib/view.ts';
  import { pendingPrompts } from '../../lib/permissions.ts';
  import { S, openDrawer, req } from '../../lib/app.svelte.ts';
  import { ticker } from '../../lib/clock.svelte.ts';
  import { keepFocus } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const groups = $derived(inboxGroups(data.jobs));
  const reqs = $derived(data.requests ?? []);
  // The same source PermissionPrompts reads, so the section renders exactly when it lists something.
  const prompts = $derived(pendingPrompts(S.data?.daemons ?? null).length);
  // An answered prompt unmounts with its buttons: focus back on the popover, not the body.
  $effect(() => {
    void prompts;
    keepFocus();
  });
</script>

<!-- plain: the popover's own surface, so the panel keeps its text off the grain wherever it renders. -->
<div class="plain flex flex-col gap-5">
  {#if prompts}<PermissionPrompts />{/if}
  <section class="flex flex-col gap-3" aria-labelledby="needs-urgent">
    <h3 id="needs-urgent" class="label">{$t('needs.urgent')}</h3>
    {#if groups.urgent.length}
      {#each groups.urgent as j (j.id)}<InboxCard job={j} />{/each}
    {:else if prompts}
      <p class="text-sm text-muted">{$t('needs.noDecisions')}</p>
    {:else}
      <p class="text-sm text-muted">{$t('needs.empty')}</p>
    {/if}
  </section>
  {#if groups.prs.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-prs">
      <h3 id="needs-prs" class="label">{$t('inbox.prs')}</h3>
      <div class="plate flat"><div class="overflow-x-auto">
        <table class="tbl">
          <tbody>
            {#each groups.prs as j (j.id)}
              {@const u = safeUrl(j.pr?.url)}
              <tr>
                <td><button class="h card text-left hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button></td>
                <td><PrChip pr={j.pr} /></td>
                <td class="text-muted">{j.pr?.unresolvedThreads ? $t('inbox.threads', { count: j.pr.unresolvedThreads }) : $t('inbox.noThreads')}{j.pr?.behindBy ? $t('inbox.behind', { count: j.pr.behindBy }) : ''}</td>
                <td class="r whitespace-nowrap"><div class="flex justify-end gap-2">{#if u}<a class="btn sm" href={u} target="_blank" rel="noopener"><Icon name="pull-request" />{$t('inbox.openPr')}</a>{/if}<button class="btn sm" onclick={() => req({ type: 'rework', job: j.id, fixedText: 'Address the PR feedback' })}>{$t('inbox.addressFeedback')}</button></div></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div></div>
    </section>
  {/if}
  {#if groups.parks.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-parks">
      <h3 id="needs-parks" class="label">{$t('inbox.parks')}</h3>
      <div class="plate flat"><div class="overflow-x-auto">
        <table class="tbl">
          <tbody>
            {#each groups.parks as j (j.id)}
              <tr>
                <td><button class="h card text-left hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button><div class="mono muted text-[11px]">{cardRef(j) ?? j.id}</div></td>
                <td><DepChips job={j} /></td>
                <td class="r"><JobActions job={j} noteId="park-{j.id}" /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div></div>
    </section>
  {/if}
  {#if reqs.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-queued">
      <h3 id="needs-queued" class="label">{$t('inbox.queued')}</h3>
      <div class="plate flat"><div class="overflow-x-auto">
        <table class="tbl">
          <tbody>
            {#each reqs as r (r.id)}
              <tr>
                <td class="font-mono text-xs">{r.type}</td>
                <td>{r.job ?? ''}</td>
                <td class="text-muted">{r.text ?? ''}</td>
                <td class="text-muted whitespace-nowrap">{r.status === 'in-progress' ? $t('inbox.handling', { session: String(r.session ?? '').slice(0, 8) }) : $t('inbox.queuedStatus')}</td>
                <td class="text-muted whitespace-nowrap">{ago(r.createdAt, ticker.now)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div></div>
    </section>
  {/if}
</div>
