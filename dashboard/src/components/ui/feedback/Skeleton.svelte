<!-- One skeleton bone: a breathing bar the size of the text, chip or panel that will sit there once the data arrives.
     `w` and `h` are any CSS length; `round` draws a dot or pill. Decorative only: put bones inside a <Loading>, which
     announces the wait once. Like text, a bone sits on a plate (or plain, solid, chrome), never on the grain. -->
<script lang="ts">
  let { w = '100%', h = '0.875rem', round = false, class: extra = '' }: { w?: string; h?: string; round?: boolean; class?: string } = $props();
</script>

<span class="skeleton {round ? 'round' : ''} {extra}" style="width:{w};height:{h}" aria-hidden="true"></span>
