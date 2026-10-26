<!-- The mandate editor, inline: a new mandate's (above the list) or one mandate's (in place of its card). It has no id
     field: the server picks a new mandate's id (m-<8 hex>), which the success toast names. Fields: the title; the scope as comma-separated milestones, labels
     and issues (hidden for a goal mandate in intake, whose scope stays empty); until, max jobs and order; one checkbox per
     grantable class (a written class the config no longer grants stays checked and disabled, with a note); the budget,
     stall and unfinishable terms; after (none or another mandate); the guidance, fenced as data in briefs. A new mandate
     shows foreman.mandate's defaults; an edit loads the mandate with its guidance (GET /api/mandates/:id) and sends only
     what changed, pinned to the updatedAt it loaded. A refusal shows the server's error under the form and keeps every
     field; a success closes the editor, reloads and toasts. Owner text renders only as Svelte text and input values. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Select from './Select.svelte';
  import { blankForm, editMandateBody, fetchMandate, formOf, inIntake, isUnreadable, newMandateBody, postMandate, postMandateEdit, type MandateForm } from '../lib/foreman.ts';
  import { MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_UNTIL } from '../lib/types.ts';
  import { forgeToken, loadMandates, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
  import type { MandateDetailResponse, MandateRow, MandatesResponse } from '../lib/types.ts';
  import type { SelectOption } from '../lib/select.ts';

  let { mandates, row, onclose }: { mandates: MandatesResponse; row?: MandateRow; onclose: () => void } = $props();

  const BODY_MAX = 8000;
  const editing = $derived(row !== undefined);
  const uid = $props.id();
  const d = $derived(mandates.defaults);

  let form = $state<MandateForm>(blankForm());
  let detail = $state.raw<MandateDetailResponse | null>(null);
  let loadError = $state<string | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let first = $state<HTMLInputElement>();

  onMount(() => {
    if (!row) {
      form = { ...blankForm(), until: d.until, order: d.order, onUnfinishable: d.onUnfinishable };
      first?.focus();
      return;
    }
    const id = row.id;
    fetchMandate(id, forgeToken())
      .then((r) => {
        detail = r;
        form = formOf(r, r.body);
      })
      .catch((e: unknown) => (loadError = e instanceof Error ? e.message : String(e)));
  });

  $effect(() => {
    if (detail) first?.focus();
  });

  const intake = $derived(detail ? inIntake(detail) : false);
  const ready = $derived(!editing || detail !== null);
  /** The classes the checkboxes offer: the grantable ones, then any written class the config no longer grants. */
  const decidesChecked = $derived(form.decides ?? d.decides);
  const ungranted = $derived((form.decides ?? []).filter((c) => !mandates.grantable.includes(c as never)));
  const afterOptions = $derived<SelectOption[]>([
    { value: '', label: $t('foreman.editor.afterNone') },
    ...mandates.mandates.filter((m) => !isUnreadable(m) && m.id !== row?.id).map((m) => ({ value: m.id, label: m.id })),
  ]);
  const choices = (list: readonly string[]): SelectOption[] => list.map((v) => ({ value: v, label: v }));

  function toggle(cls: string, on: boolean): void {
    const now = [...decidesChecked];
    form.decides = on ? [...now.filter((c) => c !== cls), cls] : now.filter((c) => c !== cls);
  }

  async function save(): Promise<void> {
    if (saving) return;
    error = null;
    saving = true;
    try {
      if (detail) {
        await postMandateEdit(detail.id, editMandateBody(detail, detail, form), forgeToken());
        toast($t('foreman.editor.saved', { id: row?.id ?? '' }));
      } else {
        const res = await postMandate(newMandateBody(form), forgeToken());
        toast($t('foreman.editor.created', { id: res.mandate.id }));
      }
      onclose();
      await Promise.all([loadMandates(), refresh()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const num = (k: 'maxJobs' | 'budgetUsd' | 'budgetJobs' | 'stallCadences' | 'stallBounces') => (e: Event & { currentTarget: HTMLInputElement }) => (form[k] = e.currentTarget.value);
</script>

{#snippet field(id: string, label: string)}
  <label for={id} class="label text-[10px]">{label}</label>
{/snippet}

<form class="plate p-4 flex flex-col gap-4" aria-labelledby="{uid}-title" onsubmit={(e) => { e.preventDefault(); save(); }}>
  <h3 id="{uid}-title" class="h section">{editing ? $t('foreman.editor.editTitle', { id: row?.id ?? '' }) : $t('foreman.editor.newTitle')}</h3>
  {#if loadError}
    <p class="text-[13px] text-bad break-words" role="alert">{$t('foreman.editor.loadFailed', { error: loadError })}</p>
    <div><button type="button" class="btn" onclick={onclose}>{$t('foreman.editor.cancel')}</button></div>
  {:else if !ready}
    <p class="muted text-[13px]">{$t('common.loading')}</p>
  {:else}
    <div class="flex flex-col gap-1">
      {@render field(`${uid}-title-input`, $t('foreman.editor.title'))}
      <input bind:this={first} id="{uid}-title-input" type="text" class="w-full" maxlength="200" bind:value={form.title} />
    </div>

    {#if !intake}
      <fieldset class="flex flex-col gap-2">
        <legend class="label text-[10px] mb-1">{$t('foreman.editor.scope')}</legend>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="flex flex-col gap-1">{@render field(`${uid}-milestones`, $t('foreman.mandate.milestones'))}<input id="{uid}-milestones" type="text" class="w-full" aria-describedby="{uid}-lists" bind:value={form.milestones} /></div>
          <div class="flex flex-col gap-1">{@render field(`${uid}-labels`, $t('foreman.mandate.labels'))}<input id="{uid}-labels" type="text" class="w-full" aria-describedby="{uid}-lists" bind:value={form.labels} /></div>
          <div class="flex flex-col gap-1">{@render field(`${uid}-issues`, $t('foreman.mandate.issues'))}<input id="{uid}-issues" type="text" class="w-full" aria-describedby="{uid}-lists" bind:value={form.issues} /></div>
        </div>
        <span id="{uid}-lists" class="text-[11px] text-muted">{$t('foreman.editor.listsHint')}</span>
      </fieldset>
    {/if}

    <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
      <div class="flex flex-col gap-1"><span id="{uid}-until-l" class="label text-[10px]">{$t('foreman.mandate.until')}</span><Select labelledby="{uid}-until-l" value={form.until} options={choices(MANDATE_UNTIL)} onchange={(v) => (form.until = v)} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-max`, $t('foreman.mandate.maxJobs'))}<input id="{uid}-max" type="number" min="1" max="16" step="1" class="w-full" placeholder={String(d.maxJobs)} value={form.maxJobs} oninput={num('maxJobs')} /></div>
      <div class="flex flex-col gap-1"><span id="{uid}-order-l" class="label text-[10px]">{$t('foreman.mandate.order')}</span><Select labelledby="{uid}-order-l" value={form.order} options={choices(MANDATE_ORDERS)} onchange={(v) => (form.order = v)} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-usd`, $t('foreman.editor.budgetUsd'))}<input id="{uid}-usd" type="number" min="0" step="any" class="w-full" placeholder={String(d.budget.usd)} value={form.budgetUsd} oninput={num('budgetUsd')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-jobs`, $t('foreman.editor.budgetJobs'))}<input id="{uid}-jobs" type="number" min="1" max="1000" step="1" class="w-full" placeholder={String(d.budget.jobs)} value={form.budgetJobs} oninput={num('budgetJobs')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-cad`, $t('foreman.editor.stallCadences'))}<input id="{uid}-cad" type="number" min="1" max="100" step="1" class="w-full" placeholder={String(d.stall.cadences)} value={form.stallCadences} oninput={num('stallCadences')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-bounces`, $t('foreman.editor.stallBounces'))}<input id="{uid}-bounces" type="number" min="1" max="100" step="1" class="w-full" placeholder={String(d.stall.bounces)} value={form.stallBounces} oninput={num('stallBounces')} /></div>
      <div class="flex flex-col gap-1"><span id="{uid}-unf-l" class="label text-[10px]">{$t('foreman.mandate.onUnfinishable')}</span><Select labelledby="{uid}-unf-l" value={form.onUnfinishable} options={choices(MANDATE_ON_UNFINISHABLE)} onchange={(v) => (form.onUnfinishable = v)} /></div>
      <div class="flex flex-col gap-1"><span id="{uid}-after-l" class="label text-[10px]">{$t('foreman.editor.after')}</span><Select labelledby="{uid}-after-l" value={form.after} options={afterOptions} onchange={(v) => (form.after = v)} /></div>
    </div>

    <fieldset class="flex flex-col gap-1">
      <legend class="label text-[10px] mb-1">{$t('foreman.mandate.decides')}</legend>
      {#if !mandates.grantable.length && !ungranted.length}<p class="text-[12px] text-muted">{$t('foreman.editor.noGrantable')}</p>{/if}
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        {#each mandates.grantable as cls (cls)}<label class="field min-h-8"><input type="checkbox" class="check" checked={decidesChecked.includes(cls)} onchange={(e) => toggle(cls, e.currentTarget.checked)} /><span class="mono">{cls}</span></label>{/each}
        {#each ungranted as cls (cls)}<label class="field min-h-8 text-muted"><input type="checkbox" class="check" checked disabled aria-describedby="{uid}-ungranted" /><span class="mono">{cls}</span></label>{/each}
      </div>
      {#if ungranted.length}<span id="{uid}-ungranted" class="text-[11px] text-muted">{$t('foreman.editor.ungranted')}</span>{/if}
    </fieldset>

    <div class="flex flex-col gap-1">
      {@render field(`${uid}-body`, $t('foreman.editor.guidance'))}
      <textarea id="{uid}-body" rows="4" class="w-full" maxlength={BODY_MAX} aria-describedby="{uid}-body-hint" bind:value={form.body}></textarea>
      <span id="{uid}-body-hint" class="text-[11px] text-muted">{$t('foreman.editor.guidanceHint', { count: form.body.length, max: BODY_MAX })}</span>
    </div>

    {#if error}<p class="text-[13px] text-bad break-words" role="alert">{error}</p>{/if}
    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn primary" disabled={saving} aria-busy={saving}>{$t('foreman.editor.save')}</button>
      <button type="button" class="btn" disabled={saving} onclick={onclose}>{$t('foreman.editor.cancel')}</button>
    </div>
  {/if}
</form>
