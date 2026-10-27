<!-- The mandate editor, in a centred modal (the Add project shell: backdrop, focus trap, Escape, scroll lock; a full-screen
     sheet below md): a new mandate's or one mandate's. It has no id
     field: the server picks a new mandate's id (m-<8 hex>), which the success toast names. Fields: the title; the scope
     as comma-separated milestones, labels and issues (hidden for a goal mandate in intake, whose scope stays empty);
     until, max jobs and order; one checkbox per grantable class (a written class the config no longer grants stays
     checked and disabled, with a note); the budget, stall and unfinishable terms; after (none or another mandate); the
     guidance, fenced as data in briefs. Every label, legend and class has an info icon (FieldHint) whose hint the field
     also lists in its aria-describedby; each hint id ends in `-about`. A new mandate shows foreman.mandate's defaults; an
     edit loads the mandate with its guidance (GET /api/mandates/:id) and sends only what changed, pinned to the
     updatedAt it loaded. A refusal shows the server's error under the form and keeps every field; a success closes the
     editor, reloads and toasts. Owner text renders only as Svelte text and input values. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import FieldHint from './FieldHint.svelte';
  import Select from './Select.svelte';
  import { blankForm, editMandateBody, fetchMandate, formOf, inIntake, isUnreadable, newMandateBody, postMandate, postMandateEdit, type MandateForm } from '../lib/foreman.ts';
  import { MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_UNTIL } from '../lib/types.ts';
  import { loadMandates, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
  import { EXIT, fade, pop } from '../lib/motion.ts';
  import { lockScroll } from '../lib/scroll-lock.ts';
  import { wrapFocus } from '../lib/settings.ts';
  import type { GateClass, MandateDetailResponse, MandateRow, MandatesResponse } from '../lib/types.ts';
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
  let dialog = $state<HTMLDivElement>();
  let pressedOnBackdrop = false;

  const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trap(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !e.defaultPrevented && !saving) {
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key !== 'Tab' || !dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
    const n = wrapFocus(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (n === null) return;
    e.preventDefault();
    items[n].focus();
  }

  // Both ends of the click must be on the backdrop: a text selection dragged out of the dialog ends its click there too.
  function backdropDown(e: MouseEvent): void {
    pressedOnBackdrop = e.target === e.currentTarget;
  }

  function backdrop(e: MouseEvent): void {
    const both = pressedOnBackdrop && e.target === e.currentTarget;
    pressedOnBackdrop = false;
    if (both && !saving && matchMedia('(min-width: 768px)').matches) onclose();
  }

  onMount(() => {
    const unlock = lockScroll();
    dialog?.focus();
    return unlock;
  });

  onMount(() => {
    if (!row) {
      form = { ...blankForm(), until: d.until, order: d.order, onUnfinishable: d.onUnfinishable };
      first?.focus();
      return;
    }
    const id = row.id;
    fetchMandate(id)
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
  /** One hint per gate class: a class added to OFFICE_GATES without one fails the type check. */
  const classHints = $derived<Record<GateClass, string>>({
    'spec-approval': $t('foreman.editor.hints.classes.specApproval'),
    'split-approval': $t('foreman.editor.hints.classes.splitApproval'),
    escalation: $t('foreman.editor.hints.classes.escalation'),
    'rounds-exhausted': $t('foreman.editor.hints.classes.roundsExhausted'),
    conflicts: $t('foreman.editor.hints.classes.conflicts'),
    'pr-feedback': $t('foreman.editor.hints.classes.prFeedback'),
    'repo-proposal': $t('foreman.editor.hints.classes.repoProposal'),
    release: $t('foreman.editor.hints.classes.release'),
    'milestone-approval': $t('foreman.editor.hints.classes.milestoneApproval'),
  });
  const classHint = (cls: string): string | null => (Object.hasOwn(classHints, cls) ? classHints[cls as GateClass] : null);

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
        await postMandateEdit(detail.id, editMandateBody(detail, detail, form));
        toast($t('foreman.editor.saved', { id: row?.id ?? '' }));
      } else {
        const res = await postMandate(newMandateBody(form));
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

{#snippet field(id: string, label: string, hint: string)}
  <span class="flex items-center gap-1"><label for={id} class="label text-[10px]">{label}</label><FieldHint id="{id}-about" {label} text={hint} /></span>
{/snippet}

<!-- A Select's label: a span the Select names itself by (`{id}-l`), with the same icon. -->
{#snippet heading(id: string, label: string, hint: string)}
  <span class="flex items-center gap-1"><span id="{id}-l" class="label text-[10px]">{label}</span><FieldHint id="{id}-about" {label} text={hint} /></span>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop; Escape, Cancel and the close button close the dialog from the keyboard) -->
<div class="fixed inset-0 z-45 flex md:items-center md:justify-center md:p-6 backdrop" in:fade|global out:fade|global={EXIT} onmousedown={backdropDown} onclick={backdrop}>
<div bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="{uid}-title" tabindex="-1" in:pop|global class="plate solid flex flex-col w-full h-full min-w-0 md:h-auto md:max-h-[85vh] md:max-w-[672px] md:shadow-(--shadow-overlay)" onkeydown={trap}>
<div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2 md:px-5">
  <h2 id="{uid}-title" class="h sheet-title min-w-0">{editing ? $t('foreman.editor.editTitle', { id: row?.id ?? '' }) : $t('foreman.editor.newTitle')}</h2>
  <CloseButton label={$t('foreman.editor.cancel')} onclick={onclose} />
</div>
<form class="flex flex-col flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 md:px-6 gap-4" onsubmit={(e) => { e.preventDefault(); save(); }}>
  {#if loadError}
    <p class="text-[13px] text-bad break-words" role="alert">{$t('foreman.editor.loadFailed', { error: loadError })}</p>
    <div><button type="button" class="btn" onclick={onclose}>{$t('foreman.editor.cancel')}</button></div>
  {:else if !ready}
    <p class="muted text-[13px]">{$t('common.loading')}</p>
  {:else}
    <div class="flex flex-col gap-1">
      {@render field(`${uid}-title-input`, $t('foreman.editor.title'), $t('foreman.editor.hints.title'))}
      <input bind:this={first} id="{uid}-title-input" type="text" class="w-full" maxlength="200" aria-describedby="{uid}-title-input-about" bind:value={form.title} />
    </div>

    {#if !intake}
      <!-- Named by the legend's text alone: the legend also holds the icon and its hint, so the label style stays on
           the text span too, and the hint and its tip don't take its capitals. -->
      <fieldset class="flex flex-col gap-2" aria-labelledby="{uid}-scope-l" aria-describedby="{uid}-scope-about">
        <legend class="mb-1 flex items-center gap-1"><span id="{uid}-scope-l" class="label text-[10px]">{$t('foreman.editor.scope')}</span><FieldHint id="{uid}-scope-about" label={$t('foreman.editor.scope')} text={$t('foreman.editor.hints.scope')} /></legend>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="flex flex-col gap-1">{@render field(`${uid}-milestones`, $t('foreman.mandate.milestones'), $t('foreman.editor.hints.milestones'))}<input id="{uid}-milestones" type="text" class="w-full" aria-describedby="{uid}-milestones-about {uid}-lists" bind:value={form.milestones} /></div>
          <div class="flex flex-col gap-1">{@render field(`${uid}-labels`, $t('foreman.mandate.labels'), $t('foreman.editor.hints.labels'))}<input id="{uid}-labels" type="text" class="w-full" aria-describedby="{uid}-labels-about {uid}-lists" bind:value={form.labels} /></div>
          <div class="flex flex-col gap-1">{@render field(`${uid}-issues`, $t('foreman.mandate.issues'), $t('foreman.editor.hints.issues'))}<input id="{uid}-issues" type="text" class="w-full" aria-describedby="{uid}-issues-about {uid}-lists" bind:value={form.issues} /></div>
        </div>
        <span id="{uid}-lists" class="text-[11px] text-muted">{$t('foreman.editor.listsHint')}</span>
      </fieldset>
    {/if}

    <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
      <div class="flex flex-col gap-1">{@render heading(`${uid}-until`, $t('foreman.mandate.until'), $t('foreman.editor.hints.until'))}<Select labelledby="{uid}-until-l" describedby="{uid}-until-about" value={form.until} options={choices(MANDATE_UNTIL)} onchange={(v) => (form.until = v)} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-max`, $t('foreman.mandate.maxJobs'), $t('foreman.editor.hints.maxJobs'))}<input id="{uid}-max" type="number" min="1" max="16" step="1" class="w-full" aria-describedby="{uid}-max-about" placeholder={String(d.maxJobs)} value={form.maxJobs} oninput={num('maxJobs')} /></div>
      <div class="flex flex-col gap-1">{@render heading(`${uid}-order`, $t('foreman.mandate.order'), $t('foreman.editor.hints.order'))}<Select labelledby="{uid}-order-l" describedby="{uid}-order-about" value={form.order} options={choices(MANDATE_ORDERS)} onchange={(v) => (form.order = v)} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-usd`, $t('foreman.editor.budgetUsd'), $t('foreman.editor.hints.budgetUsd'))}<input id="{uid}-usd" type="number" min="0" step="any" class="w-full" aria-describedby="{uid}-usd-about" placeholder={String(d.budget.usd)} value={form.budgetUsd} oninput={num('budgetUsd')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-jobs`, $t('foreman.editor.budgetJobs'), $t('foreman.editor.hints.budgetJobs'))}<input id="{uid}-jobs" type="number" min="1" max="1000" step="1" class="w-full" aria-describedby="{uid}-jobs-about" placeholder={String(d.budget.jobs)} value={form.budgetJobs} oninput={num('budgetJobs')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-cad`, $t('foreman.editor.stallCadences'), $t('foreman.editor.hints.stallCadences'))}<input id="{uid}-cad" type="number" min="1" max="100" step="1" class="w-full" aria-describedby="{uid}-cad-about" placeholder={String(d.stall.cadences)} value={form.stallCadences} oninput={num('stallCadences')} /></div>
      <div class="flex flex-col gap-1">{@render field(`${uid}-bounces`, $t('foreman.editor.stallBounces'), $t('foreman.editor.hints.stallBounces'))}<input id="{uid}-bounces" type="number" min="1" max="100" step="1" class="w-full" aria-describedby="{uid}-bounces-about" placeholder={String(d.stall.bounces)} value={form.stallBounces} oninput={num('stallBounces')} /></div>
      <div class="flex flex-col gap-1">{@render heading(`${uid}-unf`, $t('foreman.mandate.onUnfinishable'), $t('foreman.editor.hints.onUnfinishable'))}<Select labelledby="{uid}-unf-l" describedby="{uid}-unf-about" value={form.onUnfinishable} options={choices(MANDATE_ON_UNFINISHABLE)} onchange={(v) => (form.onUnfinishable = v)} /></div>
      <div class="flex flex-col gap-1">{@render heading(`${uid}-after`, $t('foreman.editor.after'), $t('foreman.editor.hints.after'))}<Select labelledby="{uid}-after-l" describedby="{uid}-after-about" value={form.after} options={afterOptions} onchange={(v) => (form.after = v)} /></div>
    </div>

    <fieldset class="flex flex-col gap-1" aria-labelledby="{uid}-decides-l" aria-describedby="{uid}-decides-about">
      <legend class="mb-1 flex items-center gap-1"><span id="{uid}-decides-l" class="label text-[10px]">{$t('foreman.mandate.decides')}</span><FieldHint id="{uid}-decides-about" label={$t('foreman.mandate.decides')} text={$t('foreman.editor.hints.decides')} /></legend>
      {#if !mandates.grantable.length && !ungranted.length}<p class="text-[12px] text-muted">{$t('foreman.editor.noGrantable')}</p>{/if}
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <!-- The icon sits outside the <label>, so a click on it never reaches the checkbox. -->
        {#each mandates.grantable as cls (cls)}<span class="inline-flex items-center gap-1"><label class="field min-h-8"><input type="checkbox" class="check" checked={decidesChecked.includes(cls)} aria-describedby="{uid}-cls-{cls}-about" onchange={(e) => toggle(cls, e.currentTarget.checked)} /><span class="mono">{cls}</span></label><FieldHint id="{uid}-cls-{cls}-about" label={cls} text={classHints[cls]} /></span>{/each}
        {#each ungranted as cls (cls)}{@const hint = classHint(cls)}<span class="inline-flex items-center gap-1"><label class="field min-h-8 text-muted"><input type="checkbox" class="check" checked disabled aria-describedby={hint === null ? `${uid}-ungranted` : `${uid}-cls-${cls}-about ${uid}-ungranted`} /><span class="mono">{cls}</span></label>{#if hint !== null}<FieldHint id="{uid}-cls-{cls}-about" label={cls} text={hint} />{/if}</span>{/each}
      </div>
      {#if ungranted.length}<span id="{uid}-ungranted" class="text-[11px] text-muted">{$t('foreman.editor.ungranted')}</span>{/if}
    </fieldset>

    <div class="flex flex-col gap-1">
      {@render field(`${uid}-body`, $t('foreman.editor.guidance'), $t('foreman.editor.hints.guidance'))}
      <textarea id="{uid}-body" rows="4" class="w-full" maxlength={BODY_MAX} aria-describedby="{uid}-body-about {uid}-body-hint" bind:value={form.body}></textarea>
      <span id="{uid}-body-hint" class="text-[11px] text-muted">{$t('foreman.editor.guidanceHint', { count: form.body.length, max: BODY_MAX })}</span>
    </div>

    {#if error}<p class="text-[13px] text-bad break-words" role="alert">{error}</p>{/if}
    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn primary" disabled={saving} aria-busy={saving}>{$t('foreman.editor.save')}</button>
      <button type="button" class="btn" disabled={saving} onclick={onclose}>{$t('foreman.editor.cancel')}</button>
    </div>
  {/if}
</form>
</div>
</div>
