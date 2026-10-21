<!-- The drawer's Environment card, for active jobs only: Focus or Unfocus (a pointer, POST /api/focus), Open in editor
     (the worktree in FORGE_EDITOR on the machine running forge dash), the job's component endpoints (an Open link, the dev
     server's with a live dot), the dev server row and the backing services list (GET /api/jobs/:id/environment, polled
     every 5 s while the tab is visible) with their Start, Stop, Restart and Logs controls, and one log viewer at a time.
     Nothing here starts, stops or signals another job's processes: the server proves every pid it signals. Endpoint URLs
     come from the server, built from an integer port, and every log line and error renders as text. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import Chip from './Chip.svelte';
  import EnvironmentLog from './EnvironmentLog.svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import LiveDot from './LiveDot.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { environmentModel, postEditor, postFocus } from '../lib/focus.ts';
  import { actionToast, backingButtons, backingSource, devButtons, devChip, dockerDown as dockerIsDown, fetchEnvironment, logHint, postEnvironment, serviceChip, type ButtonHint } from '../lib/environment.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import type { DevState, EnvironmentAction, EnvironmentService, EnvironmentTarget, Job, JobEnvironmentResponse } from '../lib/types.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Pick<Job, 'id' | 'state' | 'worktree'> } = $props();
  // /api/state carries the endpoints and is polled, so the live dot follows it; the detail's job is the fallback.
  const row = $derived(S.data?.jobs?.find((j) => j.id === job.id) ?? null);
  const model = $derived(environmentModel({ id: job.id, state: row?.state ?? job.state, worktree: row?.worktree ?? job.worktree, endpoints: row?.endpoints }, S.data?.focus?.id));
  // Backing rows move to the Backing services list.
  const components = $derived(model.endpoints.filter((e) => e.kind === 'component'));
  let busy = $state<string | null>(null);
  let env = $state.raw<JobEnvironmentResponse | null>(null);
  let pollError = $state<string | null>(null);
  /** The open log viewer's source (`dev` or `backing:<name>`), one at a time. */
  let logSource = $state<string | null>(null);
  const dev = $derived(devButtons(env));
  const backing = $derived(backingButtons(env));
  const devName = $derived<Record<DevState, string>>({ running: $t('environment.dev.states.running'), starting: $t('environment.dev.states.starting'), down: $t('environment.dev.states.down'), stopped: $t('environment.dev.states.stopped') });
  const serviceName = $derived<Record<EnvironmentService['state'], string>>({
    running: $t('environment.backing.states.running'),
    stopped: $t('environment.backing.states.stopped'),
    missing: $t('environment.backing.states.missing'),
    unknown: $t('environment.backing.states.unknown'),
    external: $t('environment.backing.states.external'),
  });
  const healthName = $derived<Record<string, string>>({ healthy: $t('environment.backing.health.healthy'), unhealthy: $t('environment.backing.health.unhealthy'), starting: $t('environment.backing.health.starting') });
  const isolationName = $derived<Record<string, string>>({ 'per-job': $t('environment.backing.isolation.perJob'), shared: $t('environment.backing.isolation.shared'), external: $t('environment.backing.isolation.external') });
  const hintText = $derived<Record<Exclude<ButtonHint, null>, string>>({ inactive: $t('environment.hints.inactive'), noWorktree: $t('environment.hints.noWorktree'), noManaged: $t('environment.hints.noManaged') });
  const toastText = $derived<Record<ReturnType<typeof actionToast>, string>>({
    devStarted: $t('environment.toasts.devStarted'),
    devStopped: $t('environment.toasts.devStopped'),
    devRestarted: $t('environment.toasts.devRestarted'),
    backingStarted: $t('environment.toasts.backingStarted'),
    backingStopped: $t('environment.toasts.backingStopped'),
    backingRestarted: $t('environment.toasts.backingRestarted'),
  });
  const dockerDown = $derived(dockerIsDown(env));
  const logHintText = $derived<Record<Exclude<ReturnType<typeof logHint>, null>, string>>({ logsMissing: $t('environment.hints.logsMissing'), logsUnknown: $t('environment.hints.logsUnknown') });
  const hint = (h: ButtonHint): string | null => (h === null ? null : hintText[h]);
  const health = (s: EnvironmentService): string => (s.health ? healthName[s.health] : '—');
  const devHealth = (listening: boolean | null): string => (listening === null ? '—' : listening ? $t('environment.dev.listening') : $t('environment.dev.notAnswering'));

  async function load(): Promise<void> {
    try {
      env = await fetchEnvironment(job.id, forgeToken());
      pollError = null;
    } catch (err) {
      // The last answer stays on screen; the error shows beside it.
      pollError = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    if (!model.visible) return;
    void job.id;
    untrack(() => {
      env = null;
      pollError = null;
      logSource = null;
      void load();
    });
    const timer = setInterval(() => document.visibilityState === 'visible' && busy === null && void load(), 5000);
    return () => clearInterval(timer);
  });

  /** One action at a time per card: a second click while one is in flight does nothing. */
  async function act(kind: string, fn: () => Promise<string | null>): Promise<void> {
    if (busy !== null) return;
    busy = kind;
    try {
      const done = await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      await refresh();
      busy = null;
    }
  }

  const toggleFocus = () =>
    act('focus', async () => {
      await postFocus(model.focused ? null : job.id, forgeToken());
      return null;
    });
  const openEditor = () =>
    act('editor', async () => {
      const r = await postEditor(job.id, forgeToken());
      return $t('environment.editorOpened', { editor: r.editor });
    });
  const envAction = (target: EnvironmentTarget, action: EnvironmentAction) =>
    act(target, async () => {
      let r;
      try {
        r = await postEnvironment(job.id, target, action, forgeToken());
      } catch (err) {
        // A refused action changed nothing it can prove; the status may still have moved on.
        await load();
        throw err;
      }
      env = r.environment;
      if (!r.ok) throw new Error(r.detail ?? $t('environment.failed'));
      return toastText[actionToast(target, action)];
    });
  const toggleLog = (source: string) => (logSource = logSource === source ? null : source);
  const logLabel = (source: string): string => (source === 'dev' ? $t('environment.dev.title') : source.slice('backing:'.length));
</script>

{#if model.visible}
  <div class="plate p-4 flex flex-col gap-3" id="drawer-environment">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="h section">{$t('environment.title')}</h3>
      <div class="flex flex-wrap gap-2">
        <button class="btn sm" disabled={busy !== null} aria-busy={busy === 'focus'} onclick={toggleFocus}><Icon name="review" />{model.focusLabel === 'environment.unfocus' ? $t('environment.unfocus') : $t('environment.focus')}</button>
        <button class="btn sm" disabled={model.editorDisabled || busy !== null} aria-busy={busy === 'editor'} title={model.editorDisabled ? $t('environment.editorNone') : undefined} onclick={openEditor}>{$t('environment.editor')}</button>
      </div>
    </div>
    {#if components.length}
      <ul class="flex flex-col gap-1.5">
        {#each components as e (`${e.kind}:${e.name}`)}
          {@const href = safeUrl(e.url)}
          <li class="flex items-center gap-2 min-w-0 text-sm">
            {#if typeof e.live === 'boolean'}<LiveDot on={e.live} /><span class="sr-only">{e.live ? $t('environment.live') : $t('environment.stopped')}</span>{/if}
            <span class="label shrink-0">{e.name}</span>
            <span class="mono text-[13px] truncate selectable min-w-0">{e.url}</span>
            {#if href}<a class="btn sm ml-auto shrink-0" {href} target="_blank" rel="noopener">{$t('environment.open')}</a>{/if}
          </li>
        {/each}
      </ul>
    {:else if !model.endpoints.length}
      <p class="text-sm text-muted">{$t('environment.none')}</p>
    {/if}

    {#if env === null}
      <p class="text-sm text-muted">{pollError ?? $t('environment.loading')}</p>
    {:else}
      {#if env.dev}
        {@const chip = devChip(env.dev.state)}
        <section class="flex flex-col gap-2 border-t border-line-soft pt-3" aria-labelledby="env-dev-title">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <h4 class="label" id="env-dev-title">{$t('environment.dev.title')}</h4>
            <Chip tone={chip.tone} text={devName[chip.state]} />
            <span class="mono text-[13px] selectable">{env.dev.port === null ? '—' : `localhost:${env.dev.port}`}</span>
            <span class="text-xs text-muted">{devHealth(env.dev.listening)}</span>
            <span class="ml-auto flex items-center gap-1" aria-busy={busy === 'dev'}>
              <IconButton icon="play" label={$t('environment.start')} hint={hint(dev.hint)} disabled={!dev.start || busy !== null} onclick={() => envAction('dev', 'start')} />
              <IconButton icon="stop" label={$t('environment.stop')} hint={dev.stop ? null : $t('environment.hints.notRunning')} disabled={!dev.stop || busy !== null} onclick={() => envAction('dev', 'stop')} />
              <IconButton icon="refresh" label={$t('environment.restart')} hint={hint(dev.hint)} disabled={!dev.restart || busy !== null} onclick={() => envAction('dev', 'restart')} />
              <IconButton icon="terminal" label={$t('environment.logs')} pressed={logSource === 'dev'} onclick={() => toggleLog('dev')} />
            </span>
          </div>
          {#if env.dev.state === 'down' && env.dev.tail.length}
            <div class="flex flex-col gap-1">
              <span class="text-xs text-muted">{$t('environment.dev.lastLines')}</span>
              <pre class="plate flat mono selectable whitespace-pre-wrap break-words text-[12px] leading-5 p-2 m-0 max-h-48 overflow-y-auto">{env.dev.tail.join('\n')}</pre>
            </div>
          {/if}
        </section>
      {/if}

      {#if env.backing.length || env.backingError}
        <section class="flex flex-col gap-2 border-t border-line-soft pt-3" aria-labelledby="env-backing-title">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="label" id="env-backing-title">{$t('environment.backing.title')}</h4>
            <span class="ml-auto flex items-center gap-1" aria-busy={busy === 'backing'}>
              <IconButton icon="play" label={$t('environment.start')} hint={hint(backing.hint)} disabled={!backing.start || busy !== null} onclick={() => envAction('backing', 'start')} />
              <IconButton icon="stop" label={$t('environment.stop')} hint={backing.hint === 'noManaged' ? hint(backing.hint) : $t('environment.hints.stopKeeps')} disabled={!backing.stop || busy !== null} onclick={() => envAction('backing', 'stop')} />
              <IconButton icon="refresh" label={$t('environment.restart')} hint={hint(backing.hint)} disabled={!backing.restart || busy !== null} onclick={() => envAction('backing', 'restart')} />
            </span>
          </div>
          {#if env.backingError}<p class="text-sm text-bad selectable">{env.backingError}</p>{/if}
          {#if dockerDown}<p class="text-sm text-warn">{$t('environment.backing.dockerDown')}</p>{/if}
          <ul class="flex flex-col gap-1.5">
            {#each env.backing as s (s.name)}
              {@const chip = serviceChip(s.state)}
              <li class="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 text-sm">
                <span class="label shrink-0">{s.name}</span>
                <span class="text-xs text-muted">{isolationName[s.isolation] ?? s.isolation}</span>
                <Chip tone={chip.tone} text={serviceName[chip.state]} />
                {#if s.managed}
                  {@const off = logHint(s)}
                  <span class="text-xs text-muted">{health(s)}</span>
                  <span class="mono text-[13px] selectable truncate min-w-0">{Object.values(s.ports).map((p) => `127.0.0.1:${p}`).join(' ') || '—'}</span>
                  <span class="ml-auto"><IconButton icon="terminal" label={$t('environment.logs')} hint={off === null ? null : logHintText[off]} disabled={off !== null} pressed={logSource === backingSource(s.name)} onclick={() => toggleLog(backingSource(s.name))} /></span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if pollError}<p class="text-xs text-muted selectable">{$t('environment.pollFailed', { error: pollError })}</p>{/if}
    {/if}

    {#if logSource !== null}
      {#key logSource}
        <EnvironmentLog job={job.id} source={logSource} label={logLabel(logSource)} onclose={() => (logSource = null)} />
      {/key}
    {/if}
  </div>
{/if}
