<!-- One config field: label, key, help and default, then its control (or its read-only value) and any error. -->
<script lang="ts">
  import { t } from '../../lib/locale.ts';
  import { draftOf, formatValue, parseDraft, type Draft, type Parsed } from '../../lib/config-form.ts';
  import type { SettingsSession } from '../../lib/settings-session.svelte.ts';
  import type { ConfigField } from '../../lib/types.ts';

  let { field: f, value, session, disabled }: { field: ConfigField; value: unknown; session: SettingsSession; disabled: boolean } = $props();

  const id = $derived(`cfg-${f.key.replace(/[^A-Za-z0-9]/g, '-')}`);
  const draft = $derived<Draft>(Object.hasOwn(session.drafts, f.key) ? session.drafts[f.key] : draftOf(f, value));
  const parsed = $derived<Parsed>(f.editable ? parseDraft(f, draft) : { ok: true, value: null });
  const serverError = $derived(session.saveErrors[f.key] ?? null);
  const error = $derived(parsed.ok ? serverError : errorText(parsed));
  const defaultText = $derived(formatValue(f.default));
  const shown = $derived(formatValue(value));
  const describedBy = $derived(`${id}-help${error ? ` ${id}-error` : ''}`);

  // Literal keys only: config-form.ts returns these.
  function errorText(p: Extract<Parsed, { ok: false }>): string {
    switch (p.error) {
      case 'settings.form.required':
        return $t('settings.form.required');
      case 'settings.form.integer':
        return $t('settings.form.integer');
      case 'settings.form.number':
        return $t('settings.form.number');
      case 'settings.form.min':
        return $t('settings.form.min', p.params);
      case 'settings.form.greater':
        return $t('settings.form.greater', p.params);
      case 'settings.form.max':
        return $t('settings.form.max', p.params);
      case 'settings.form.option':
        return $t('settings.form.option');
      case 'settings.form.listOption':
        return $t('settings.form.listOption', p.params);
      case 'settings.form.listRequired':
        return $t('settings.form.listRequired', p.params);
      case 'settings.form.tooLong':
        return $t('settings.form.tooLong', p.params);
      default:
        return $t('settings.form.readOnly');
    }
  }

  function toggle(option: string, on: boolean): void {
    const cur = Array.isArray(draft) ? draft : [];
    session.setDraft(f.key, (f.options ?? []).filter((o) => (o === option ? on : cur.includes(o))));
  }
</script>

{#snippet head()}
  <span class="text-sm font-medium">{f.label}</span>
  <span class="ml-2 font-mono text-[11px] text-muted break-all">{f.key}</span>
{/snippet}

{#snippet help()}
  <p id="{id}-help" class="text-xs text-muted">{f.help} {$t('settings.field.default', { value: defaultText ?? $t('settings.field.none') })}</p>
{/snippet}

<div class="flex flex-col gap-1.5 py-4 border-b border-line last:border-b-0 min-w-0">
  {#if !f.editable}
    <!-- Not a <label>: the value below is text, not a control. -->
    <div id="{id}-label">{@render head()}</div>
    {@render help()}
    {#if f.type === 'object'}
      <pre {id} role="group" aria-labelledby="{id}-label" aria-describedby="{id}-help" class="text-[12px] font-mono whitespace-pre-wrap break-all bg-raised rounded-lg p-3">{JSON.stringify(value ?? null, null, 2)}</pre>
    {:else}
      <div {id} role="group" aria-labelledby="{id}-label" aria-describedby="{id}-help" class="text-sm font-mono break-all">{shown ?? $t('settings.field.none')}</div>
    {/if}
    <p class="text-xs text-muted">{$t('settings.field.readOnly', { reason: f.lockedReason ?? '' })}</p>
  {:else if f.type === 'list' && f.options}
    <fieldset class="flex flex-col gap-1.5 min-w-0" aria-describedby={describedBy}>
      <legend>{@render head()}</legend>
      {@render help()}
      <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1">
        {#each f.options as o (o)}
          {@const fixed = f.required?.includes(o) ?? false}
          <label class="flex items-center gap-1.5 text-sm min-h-8"><input type="checkbox" checked={fixed || (Array.isArray(draft) && draft.includes(o))} disabled={disabled || fixed} aria-describedby={fixed ? `${id}-required` : undefined} aria-invalid={error ? 'true' : undefined} onchange={(e) => toggle(o, e.currentTarget.checked)} />{o}</label>
        {/each}
      </div>
      {#if f.required?.length}<p id="{id}-required" class="text-xs text-muted">{$t('settings.field.required', { items: f.required.join(', ') })}</p>{/if}
    </fieldset>
  {:else}
    <label for={id}>{@render head()}</label>
    {@render help()}
    {#if f.type === 'boolean'}
      <!-- The state text sits beside the checkbox, outside its label, so the checkbox's name stays the field label. -->
      <div class="flex items-center gap-2 text-sm min-h-8"><input {id} type="checkbox" checked={draft === true} {disabled} aria-describedby={describedBy} onchange={(e) => session.setDraft(f.key, e.currentTarget.checked)} /><span aria-hidden="true">{draft === true ? $t('settings.field.on') : $t('settings.field.off')}</span></div>
    {:else if f.type === 'enum'}
      <select {id} class="self-start" value={draft} {disabled} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} onchange={(e) => session.setDraft(f.key, e.currentTarget.value)}>
        {#each f.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
      </select>
    {:else if f.type === 'integer' || f.type === 'number'}
      <input {id} type="number" class="self-start w-40 max-w-full" value={draft} min={f.min !== null && !f.minExclusive ? f.min : undefined} max={f.max ?? undefined} step={f.type === 'integer' ? 1 : 'any'} {disabled} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} oninput={(e) => session.setDraft(f.key, e.currentTarget.value)} />
    {:else if f.type === 'string'}
      <input {id} type="text" class="w-full max-w-md" value={draft} list={f.suggestions ? `${id}-list` : undefined} {disabled} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} oninput={(e) => session.setDraft(f.key, e.currentTarget.value)} />
      {#if f.suggestions}<datalist id="{id}-list">{#each f.suggestions as s (s)}<option value={s}></option>{/each}</datalist>{/if}
    {:else if f.type === 'list'}
      <textarea {id} rows="3" class="w-full max-w-md font-mono" value={String(draft)} placeholder={$t('settings.field.onePerLine')} {disabled} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} oninput={(e) => session.setDraft(f.key, e.currentTarget.value)}></textarea>
    {/if}
  {/if}
  {#if error}<p id="{id}-error" class="text-xs text-bad" role={serverError && parsed.ok ? 'alert' : undefined}>{error}</p>{/if}
</div>
