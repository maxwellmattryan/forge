<!-- Settings › Diagnostics: forge doctor's checks through GET /api/doctor, a plain-text report to copy, and the redacted
     support bundle (GET /api/doctor/bundle). -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Banner from '../ui/feedback/Banner.svelte';
  import Chip from '../ui/Chip.svelte';
  import { fetchBundle } from '../../lib/core/app.svelte.ts';
  import { doctorReport, failedCount, warnCount } from '../../lib/settings/diagnostics.ts';
  import { t } from '../../lib/text/locale.ts';
  import type { SettingsSession } from '../../lib/settings/session.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';

  let { session }: { session: SettingsSession } = $props();

  const d = $derived(session.doctor);
  const failed = $derived(d ? failedCount(d) : 0);
  const warned = $derived(d ? warnCount(d) : 0);
  let fallback = $state<string | null>(null);
  let box = $state<HTMLTextAreaElement>();
  let summary = $state<HTMLDivElement>();
  let bundling = $state(false);

  /** Run again is disabled while it runs, which drops focus; the summary takes it back. */
  async function again(): Promise<void> {
    await session.runDoctor();
    await tick();
    if (!document.activeElement || document.activeElement === document.body) summary?.focus();
  }

  onMount(() => {
    if (!session.doctorAsked) session.runDoctor();
    session.loadAbout();
  });

  /** Saves the zip through a temporary object URL; the download URL carries nothing secret. */
  async function download(): Promise<void> {
    bundling = true;
    let href: string | null = null;
    try {
      const { blob, filename } = await fetchBundle();
      href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      toast($t('settings.diagnostics.bundleSaved'));
    } catch {
      toast($t('settings.diagnostics.bundleFailed'), true);
    } finally {
      if (href) URL.revokeObjectURL(href);
      bundling = false;
    }
  }

  async function copy(): Promise<void> {
    if (!d) return;
    const report = doctorReport(d, session.about);
    try {
      await navigator.clipboard.writeText(report);
      fallback = null;
      toast($t('settings.diagnostics.copied'));
    } catch {
      fallback = report;
      toast($t('settings.diagnostics.copyFailed'), true);
      await tick();
      box?.focus();
      box?.select();
    }
  }
</script>

<div class="p-4 md:p-6 flex flex-col gap-4">
  <div bind:this={summary} tabindex="-1" aria-live="polite" class="text-sm outline-none">
    {#if session.doctorRunning}<span class="text-muted">{$t('settings.diagnostics.running')}</span>
    {:else if d}<span class="font-medium {failed ? 'text-bad' : 'text-ok'}">{failed ? $t('settings.diagnostics.failed', { count: failed }) : $t('settings.diagnostics.passed')}</span>{#if warned}<span class="text-warn">{' · '}{$t('settings.diagnostics.warnings', { count: warned })}</span>{/if}{/if}
  </div>
  {#if session.doctorError && !session.doctorRunning}<Banner msg={session.doctorError} />{/if}
  {#if d}
    <div class="plate">
      <ul class="divide-y divide-line">
        {#each d.checks as c, i (i)}
          <li class="flex items-start gap-3 px-3 py-2.5 text-sm min-w-0">
            {#if !c.ok}<Chip tone="bad" text={$t('settings.diagnostics.fail')} extra="shrink-0 w-16 justify-center" />{:else if c.warn}<Chip tone="warn" text={$t('settings.diagnostics.warn')} extra="shrink-0 w-16 justify-center" />{:else}<Chip tone="ok" text={$t('settings.diagnostics.ok')} extra="shrink-0 w-16 justify-center" />{/if}
            <div class="min-w-0"><div class="font-medium">{c.name}</div>{#if c.detail}<div class="mono muted text-[11px] break-all">{c.detail}</div>{/if}</div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-2">
      <button class="btn" disabled={session.doctorRunning} onclick={again}>{$t('settings.diagnostics.again')}</button>
      <button class="btn" disabled={!d || session.doctorRunning} onclick={copy}>{$t('settings.diagnostics.copy')}</button>
      <button class="btn" disabled={bundling} onclick={download}>{bundling ? $t('settings.diagnostics.bundling') : $t('settings.diagnostics.bundle')}</button>
    </div>
    <p class="text-[11px] muted">{$t('settings.diagnostics.bundleHint')}</p>
  </div>
  {#if fallback !== null}
    <label class="label flex flex-col gap-1">{$t('settings.diagnostics.report')}<textarea bind:this={box} readonly rows="8" class="input w-full normal-case tracking-normal" value={fallback}></textarea></label>
  {/if}
</div>
