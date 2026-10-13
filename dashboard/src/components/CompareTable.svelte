<!-- The Evals compare result: config and version line, then one row per metric. -->
<script lang="ts">
  import { compareRows } from '../lib/view.ts';
  import type { EvalCompare } from '../lib/types.ts';

  let { result: c }: { result: EvalCompare } = $props();
  const rows = $derived(compareRows(c));
</script>

<div class="text-[11px] text-muted mt-3">config {c.a.configHash} → {c.b.configHash} · Forge v{c.a.forgeVersion} → v{c.b.forgeVersion}</div>
<table class="tbl mt-2">
  <thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ</th></tr></thead>
  <tbody>
    {#each rows as r (r.key)}
      <tr><td>{r.key}</td><td class="tabular-nums">{r.a}</td><td class="tabular-nums">{r.b}</td><td class="tabular-nums {r.tone}">{r.change}</td></tr>
    {/each}
  </tbody>
</table>
