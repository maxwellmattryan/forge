<!-- A field's info icon: the `about` glyph after a label, whose hint shows on hover (after TIP_DELAY_MS), at once on
     keyboard focus, and on a click or tap, which toggles it (Tooltip's toggle mode). It is a native <button type="button">
     drawn as the bare glyph (hint-icon), not a span with tabindex: a button is focusable with no a11y warning, Enter and
     Space fire the click the toggle listens for, and type="button" never submits the form. Its name is `About <label>`
     and the hint, in the sr-only span `id`, is its description; the caller lists `id` in its field's aria-describedby
     too, so a screen reader reads the hint on the field itself. Keep it outside the field's <label>, so a click on it
     never reaches a checkbox or opens a Select. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';
  import { t } from '../lib/locale.ts';

  let { id, label, text }: { id: string; label: string; text: string } = $props();

  let el = $state<HTMLButtonElement>();
</script>

<button bind:this={el} type="button" class="hint-icon" aria-label={$t('common.hintAbout', { field: label })} aria-describedby={id}><Icon name="about" class="sm" /></button><span {id} class="sr-only">{text}</span><Tooltip anchor={el} {text} toggle />