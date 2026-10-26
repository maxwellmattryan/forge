<!-- The Add project dialog: registers a repo through POST /api/projects (lib/add-project.ts), then selects it and opens its
     Project page. The Settings shell: a labelled, focus-trapped dialog, a centred plate at md and up and a full-screen plate
     below. A field the server would refuse is named under it before anything is sent; a server refusal shows above the
     buttons, keeping what was typed. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import { forgeToken, refreshMachine } from '../lib/app.svelte.ts';
  import { addProjectBody, addProjectOutcome, postProject, type AddProjectError } from '../lib/add-project.ts';
  import { closeAddProject } from '../lib/add-project.svelte.ts';
  import { t } from '../lib/locale.ts';
  import { EXIT, fade, pop } from '../lib/motion.ts';
  import { lockScroll } from '../lib/scroll-lock.ts';
  import { wrapFocus } from '../lib/settings.ts';
  import { toast } from '../lib/toast.svelte.ts';

  let dir = $state('');
  let name = $state('');
  let busy = $state(false);
  /** The field a check before sending stopped at. */
  let invalid = $state<AddProjectError | null>(null);
  /** The server's refusal, or a network failure, shown as text. */
  let failed = $state<string | null>(null);
  /** Registered, but not something the dashboard can open: the name the notice gives. */
  let unavailable = $state<string | null>(null);
  let dialog = $state<HTMLDivElement>();
  let pathInput = $state<HTMLInputElement>();
  let nameInput = $state<HTMLInputElement>();
  let pressedOnBackdrop = false;
  /** False once the dialog is gone: a reply that lands after Cancel neither navigates nor toasts. */
  let alive = true;

  const locked = $derived(busy || unavailable !== null);
  const canAdd = $derived(dir.trim() !== '' && !busy);
  const pathError = $derived(invalid === 'pathRequired' || invalid === 'pathRelative' ? invalid : null);
  const nameError = $derived(invalid === 'nameInvalid' ? invalid : null);

  // Literal keys only: addProjectBody returns these.
  function errorText(e: AddProjectError): string {
    switch (e) {
      case 'pathRequired':
        return $t('addProject.pathRequired');
      case 'pathRelative':
        return $t('addProject.pathRelative');
      default:
        return $t('addProject.nameInvalid');
    }
  }

  /** Typing clears the server's refusal, and the typed field's own error. */
  function edited(field: 'path' | 'name'): void {
    failed = null;
    if ((field === 'path' && pathError) || (field === 'name' && nameError)) invalid = null;
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!canAdd || unavailable !== null) return;
    const r = addProjectBody(dir, name);
    if ('error' in r) {
      invalid = r.error;
      failed = null;
      (r.error === 'nameInvalid' ? nameInput : pathInput)?.focus();
      return;
    }
    invalid = null;
    failed = null;
    busy = true;
    try {
      const reply = await postProject(r.body, forgeToken());
      await refreshMachine();
      if (!alive) return;
      const out = addProjectOutcome(reply);
      if (out.kind === 'unavailable') {
        unavailable = out.name;
        return;
      }
      closeAddProject();
      // route() selects the project from the hash, so the switcher shows it and its Project page renders.
      location.hash = out.hash;
      toast(out.added ? $t('addProject.added', { name: reply.project.name }) : $t('addProject.already', { name: reply.project.name }));
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trap(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
    const n = wrapFocus(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (n === null) return;
    e.preventDefault();
    items[n].focus();
  }

  // Both ends of the click must be on the backdrop, as in Settings: a text selection dragged out of the dialog ends its
  // click on the backdrop too.
  function backdropDown(e: MouseEvent): void {
    pressedOnBackdrop = e.target === e.currentTarget;
  }

  function backdrop(e: MouseEvent): void {
    const both = pressedOnBackdrop && e.target === e.currentTarget;
    pressedOnBackdrop = false;
    if (both && matchMedia('(min-width: 768px)').matches) closeAddProject();
  }

  onMount(() => {
    const unlock = lockScroll();
    tick().then(() => pathInput?.focus());
    return () => {
      alive = false;
      unlock();
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop; Escape, Cancel and the close button close the dialog from the keyboard) -->
<div class="fixed inset-0 z-45 flex md:items-center md:justify-center md:p-6 backdrop" in:fade|global out:fade|global={EXIT} onmousedown={backdropDown} onclick={backdrop}>
  <div bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="add-project-title" tabindex="-1" in:pop|global class="plate solid flex flex-col w-full h-full min-w-0 md:h-auto md:max-h-[85vh] md:max-w-[672px] md:shadow-(--shadow-overlay)" onkeydown={trap}>
    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2 md:px-5">
      <h2 id="add-project-title" class="h sheet-title min-w-0">{$t('addProject.title')}</h2>
      <CloseButton label={$t('addProject.close')} onclick={closeAddProject} />
    </div>
    <form class="flex flex-col flex-1 min-h-0" novalidate onsubmit={submit}>
      <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 md:px-6">
        <div class="flex flex-col gap-1.5 py-4 border-b border-line min-w-0">
          <label for="add-project-path" class="text-sm font-medium">{$t('addProject.path')}</label>
          <p id="add-project-path-help" class="caption muted">{$t('addProject.pathHelp')}</p>
          <input
            bind:this={pathInput}
            bind:value={dir}
            id="add-project-path"
            type="text"
            class="w-full font-mono"
            placeholder={$t('addProject.pathPlaceholder')}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            required
            readonly={locked}
            aria-invalid={pathError ? 'true' : undefined}
            aria-describedby="add-project-path-help{pathError ? ' add-project-path-error' : ''}"
            oninput={() => edited('path')}
          />
          {#if pathError}<p id="add-project-path-error" class="caption text-bad">{errorText(pathError)}</p>{/if}
        </div>
        <div class="flex flex-col gap-1.5 py-4 min-w-0">
          <label for="add-project-name" class="text-sm font-medium">{$t('addProject.name')}</label>
          <p id="add-project-name-help" class="caption muted">{$t('addProject.nameHelp')}</p>
          <input
            bind:this={nameInput}
            bind:value={name}
            id="add-project-name"
            type="text"
            class="w-full max-w-md"
            placeholder={$t('addProject.namePlaceholder')}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            readonly={locked}
            aria-invalid={nameError ? 'true' : undefined}
            aria-describedby="add-project-name-help{nameError ? ' add-project-name-error' : ''}"
            oninput={() => edited('name')}
          />
          {#if nameError}<p id="add-project-name-error" class="caption text-bad">{errorText(nameError)}</p>{/if}
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 border-t border-line bg-panel px-4 md:px-6 py-2.5">
        {#if unavailable !== null}
          <p role="alert" class="basis-full min-w-0 text-sm break-words">{$t('addProject.unavailable', { name: unavailable })}</p>
          <button type="button" class="btn primary" onclick={closeAddProject}>{$t('addProject.close')}</button>
        {:else}
          {#if failed}<p role="alert" class="basis-full min-w-0 text-sm text-bad break-words">{failed}</p>{/if}
          <button type="button" class="btn" onclick={closeAddProject}>{$t('addProject.cancel')}</button>
          <button type="submit" class="btn primary" disabled={!canAdd}>{busy ? $t('addProject.adding') : $t('addProject.add')}</button>
        {/if}
      </div>
    </form>
  </div>
</div>
