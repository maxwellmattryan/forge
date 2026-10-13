<!-- A warning banner: lost connection, newer API, missing config or a load error. -->
<script lang="ts">
  let { msg }: { msg: string } = $props();
</script>

<div class="card border-warn/40 bg-warn/10 text-warn px-4 py-3 text-sm mb-4">{msg}</div>
