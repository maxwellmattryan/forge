<!-- The Foreman page's Office panel, top to bottom: the office session (the Foreman-off note, or its permission prompts and
     SessionLog), the mandates (New mandate and the editor, the open ones, unreadable ones as one line each, then the
     closed ones folded), the assistant foremen with their current gates (only while the Foreman is on), and the latest
     directives, newest first. Mandates come from GET /api/mandates (S.mandates: on open, on the 15 s view poll and after
     each write); the assistants, gates and the office log read the /api/state poll and the session stream. Mandate,
     directive and request strings are owner, session or tracker text and render only as Svelte text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import Empty from './Empty.svelte';
  import MandateCard from './MandateCard.svelte';
  import MandateEditor from './MandateEditor.svelte';
  import PermissionPrompts from './PermissionPrompts.svelte';
  import SessionLog from './SessionLog.svelte';
  import ForemanDirectivesSkeleton from './skeletons/ForemanDirectivesSkeleton.svelte';
  import ForemanMandatesSkeleton from './skeletons/ForemanMandatesSkeleton.svelte';
  import { DIRECTIVE_TONE, assistantRows, directiveActor, directiveFeed, isUnreadable, mandateGroups, pendingGates } from '../lib/foreman.ts';
  import { pendingPrompts } from '../lib/permissions.ts';
  import { OFFICE_SCOPE } from '../lib/types.ts';
  import { ago } from '../lib/util.ts';
  import { S, openDrawer } from '../lib/app.svelte.ts';
  import { ticker } from '../lib/clock.svelte.ts';
  import { t } from '../lib/locale.ts';

  const data = $derived(S.data);
  const foremanOn = $derived(data?.daemons?.foreman === true);
  const prompts = $derived(pendingPrompts(data?.daemons ?? null, OFFICE_SCOPE).length > 0);
  const list = $derived(S.mandates);
  const groups = $derived(mandateGroups(list?.mandates ?? []));
  const jobs = $derived(data?.jobs ?? []);
  const requests = $derived(data?.requests ?? []);
  const assistants = $derived(assistantRows(data?.daemons, requests));
  const waiting = $derived(pendingGates(requests));
  const directives = $derived(directiveFeed(list?.directives ?? []));
  const jobIds = $derived(new Set(jobs.map((j) => j.id)));

  /** The editor open: a new mandate's, or one mandate's in place of its card. */
  let editing = $state<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null);
  let newButton = $state<HTMLButtonElement>();

  async function closeEditor(): Promise<void> {
    const was = editing;
    editing = null;
    await tick();
    if (was?.mode === 'edit') document.getElementById(`mandate-edit-${was.id}`)?.focus();
    else newButton?.focus();
  }

  /** The config names the off note points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{key}': 'foreman.enabled: true', '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (text: string): string[] => text.split(/(\{key\}|\{daemonKey\}|\{file\})/);
  const absolute = (iso: string): string => new Date(iso).toLocaleString();
  /** The CLI command the empty state names, as code: the message keeps it as {cmd}. */
  const NEW_CMD = 'forge mandate new';
</script>

{#snippet howTo(text: string)}
  {#each parts(text) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}
{/snippet}

<h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('foreman.office.session')}</h2>
{#if !foremanOn}
  <div class="plate flex flex-col items-start gap-2 p-4">
    <Chip extra="sm foreman off" text={$t('statusbar.foreman.tag')} />
    <p class="text-sm text-muted">{$t('statusbar.foreman.offTitle')} {$t('statusbar.foreman.offBody')}</p>
    <p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.offHow'))}</p>
    <p class="text-sm text-muted">{$t('foreman.office.offMandates')}</p>
  </div>
{:else}
  <div class="flex flex-col gap-3">
    {#if prompts}<PermissionPrompts scope={OFFICE_SCOPE} name={$t('statusbar.foreman.officeLog')} />{/if}
    <SessionLog scope={OFFICE_SCOPE} />
  </div>
{/if}

<div class="mt-8 mb-3 flex flex-wrap items-center justify-between gap-2">
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5">{$t('foreman.office.mandates')}</h2>
  <button bind:this={newButton} class="btn primary" disabled={!list || editing?.mode === 'new'} onclick={() => (editing = { mode: 'new' })}>{$t('foreman.office.new')}</button>
</div>
{#if S.mandatesError}<Banner msg={$t('foreman.office.loadFailed', { error: S.mandatesError })} />{/if}
{#if list && editing?.mode === 'new'}<div class="mb-3"><MandateEditor mandates={list} onclose={closeEditor} /></div>{/if}
{#if !list}
  {#if !S.mandatesError}<ForemanMandatesSkeleton />{/if}
{:else if !list.mandates.length}
  {#if editing?.mode !== 'new'}<Empty><p>{$t('foreman.office.noMandates')}</p><p class="text-xs mt-1">{#each $t('foreman.office.noMandatesHow').split('{cmd}') as part, i (i)}{#if i}<code class="mono">{NEW_CMD}</code>{/if}{part}{/each}</p></Empty>{/if}
{:else}
  <div class="flex flex-col gap-3">
    {#each groups.open as m (m.id)}
      {#if isUnreadable(m)}
        <div class="plate flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"><span class="mono">{m.id}</span><span class="text-bad break-words min-w-0">{$t('foreman.office.unreadable', { problem: m.problem })}</span></div>
      {:else if editing?.mode === 'edit' && editing.id === m.id}
        <MandateEditor mandates={list} row={m} onclose={closeEditor} />
      {:else}
        <MandateCard {m} jobs={jobs.filter((j) => j.mandate === m.id)} onedit={() => (editing = { mode: 'edit', id: m.id })} />
      {/if}
    {/each}
  </div>
  {#if groups.closed.length}
    <details class="mt-3">
      <summary class="plate w-fit px-3 py-1.5 text-sm cursor-pointer">{$t('foreman.office.closed', { count: groups.closed.length })}</summary>
      <div class="mt-3 flex flex-col gap-3">{#each groups.closed as m (m.id)}<MandateCard {m} jobs={[]} />{/each}</div>
    </details>
  {/if}
{/if}

{#if foremanOn}
  <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.assistants')}</h2>
  {#if assistants.length}
    <div class="plate flat"><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('foreman.office.assistant')}</th><th>{$t('foreman.office.status')}</th><th>{$t('foreman.office.gate')}</th></tr></thead>
        <tbody>
          {#each assistants as a (a.scope)}
            <tr>
              <td class="whitespace-nowrap">{$t('statusbar.foreman.assistant', { n: a.n, count: assistants.length })}</td>
              <td><Chip tone={a.status === 'busy' ? 'live' : a.status === 'off' ? 'muted' : 'ok'} text={a.status} /></td>
              <td>
                {#if !a.gate}<span class="text-muted">{$t('foreman.office.noGate')}</span>
                {:else}
                  <span class="flex flex-wrap items-center gap-2">
                    {#if 'job' in a.gate}<button class="mono hover:text-gleam" onclick={() => a.gate && 'job' in a.gate && openDrawer(a.gate.job)}>{a.gate.job}</button>{:else}<span class="mono">{a.gate.mandate}</span>{/if}
                    <Chip extra="sm" text={a.gate.gate} />
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {:else}
    <p class="plate w-fit max-w-full px-3 py-1.5 text-sm text-muted">{$t('foreman.office.noAssistants')}</p>
  {/if}
  <p class="plain w-fit max-w-full px-3 py-1.5 mt-3 text-sm text-muted">{$t('foreman.office.gatesWaiting', { count: waiting })}</p>
{/if}

<h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.directives')}</h2>
{#if !list}
  {#if !S.mandatesError}<ForemanDirectivesSkeleton />{/if}
{:else if directives.length}
  <div class="plate flat"><div class="overflow-x-auto">
    <table class="tbl">
      <thead><tr><th>{$t('foreman.office.when')}</th><th>{$t('foreman.office.mandate')}</th><th>{$t('foreman.office.action')}</th><th>{$t('foreman.office.issue')}</th><th>{$t('common.job')}</th><th>{$t('foreman.office.reason')}</th><th>{$t('foreman.office.actor')}</th></tr></thead>
      <tbody>
        {#each directives as d, i (i)}
          <tr>
            <td class="text-muted whitespace-nowrap" title={absolute(d.ts)}>{ago(d.ts, ticker.now)}</td>
            <td class="mono whitespace-nowrap">{d.mandate}</td>
            <td><Chip tone={DIRECTIVE_TONE[d.action]} text={d.action} /></td>
            <td class="mono break-all">{d.issue ?? '—'}</td>
            <td class="mono whitespace-nowrap">{#if d.job && jobIds.has(d.job)}<button class="hover:text-gleam" onclick={() => d.job && openDrawer(d.job)}>{d.job}</button>{:else}{d.job ?? '—'}{/if}</td>
            <td class="break-words min-w-[12rem]">{d.reason}</td>
            <td class="whitespace-nowrap">{directiveActor(d, $t('foreman.office.foremanActor'))}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div></div>
{:else}
  <Empty>{$t('foreman.office.noDirectives')}</Empty>
{/if}
