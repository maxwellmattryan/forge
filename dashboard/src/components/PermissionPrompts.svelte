<!-- Tool calls daemon sessions are waiting on a human to allow: the whole pool's in the status bar's Needs-you popover, one job's in
     its Thread. The tool input, the agent's description and paths are session output, i.e. untrusted, and render as text.
     Only the decision is posted; the server builds what the session receives from claude's own request. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { ago } from '../lib/util.ts';
  import { INBOX_SCOPE } from '../lib/types.ts';
  import type { PermissionDecision } from '../lib/types.ts';
  import { grantsMore, pendingPrompts, postPermission, promptInput } from '../lib/permissions.ts';
  import { S, forgeToken, openDrawer, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { scope }: { scope?: string } = $props();
  const prompts = $derived(pendingPrompts(S.data?.daemons ?? null, scope));
  /** Prompt ids with a POST in flight, so a double click can't answer twice. */
  let answering = $state<string[]>([]);

  async function answer(promptScope: string, id: string, decision: PermissionDecision): Promise<void> {
    answering = [...answering, id];
    try {
      await postPermission(promptScope, id, decision, forgeToken());
    } catch (err) {
      toast($t('permission.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    }
    answering = answering.filter((a) => a !== id);
    refresh();
  }
</script>

{#if prompts.length}
  <section class="flex flex-col gap-2" aria-label={$t('permission.heading', { count: prompts.length })}>
    {#each prompts as { scope: s, prompt: p } (p.id)}
      <article class="plate ember p-3 flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Chip tone="warn" text={$t('permission.chip')} />
          {#if scope === undefined}
            {#if s === INBOX_SCOPE}<span class="text-muted">{$t('permission.inbox')}</span>{:else}<button class="mono text-fg underline decoration-dotted cursor-pointer truncate max-w-full" title={s} onclick={() => openDrawer(s, null, 'log')}>{s}</button>{/if}
          {/if}
          <span class="text-fg">{p.agentId ? $t('permission.asksSubagent', { tool: p.tool }) : $t('permission.asks', { tool: p.tool })}</span>
          <span class="flex-1"></span>
          {#if p.at}<span class="text-muted">{ago(p.at)}</span>{/if}
        </div>
        <pre class="max-h-48 overflow-auto border border-line-soft px-2.5 py-2 mono whitespace-pre-wrap break-all">{promptInput(p)}</pre>
        {#if p.description}<p class="text-xs text-muted break-words"><span class="font-medium text-fg">{$t('permission.agentSays')}</span> {p.description}</p>{/if}
        {#if p.blockedPath}<p class="text-xs text-muted break-all"><span class="font-medium text-fg">{$t('permission.outside')}</span> <span class="mono">{p.blockedPath}</span></p>{/if}
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn sm" disabled={answering.includes(p.id)} onclick={() => answer(s, p.id, 'allow')}>{$t('permission.allow')}</button>
          {#if grantsMore(p)}<button class="btn sm" disabled={answering.includes(p.id)} onclick={() => answer(s, p.id, 'session')}>{$t('permission.allowSession')}</button>{/if}
          <button class="btn sm" disabled={answering.includes(p.id)} onclick={() => answer(s, p.id, 'deny')}>{$t('permission.deny')}</button>
          {#if grantsMore(p)}<span class="min-w-0 flex-1 truncate text-[11px] text-muted" title={[...p.sessionRules, ...p.sessionDirs].join('\n')}>{$t('permission.sessionGrants', { grants: [...p.sessionRules, ...p.sessionDirs].join(', ') })}</span>{/if}
        </div>
      </article>
    {/each}
  </section>
{/if}
