<!-- The Evals compare result: config and version line, then one row per metric. -->
<script lang="ts">
  import { compareRows } from '../lib/view.ts';
  import type { EvalCompare } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { result: c }: { result: EvalCompare } = $props();
  const rows = $derived(compareRows(c));
</script>

<div class="text-[11px] text-muted mt-3">{$t('compare.summary', { a: c.a.configHash, b: c.b.configHash, va: c.a.forgeVersion, vb: c.b.forgeVersion })}</div>
<table class="tbl mt-2">
  <thead><tr><th>{$t('compare.metric')}</th><th>{$t('compare.a')}</th><th>{$t('compare.b')}</th><th>Δ</th></tr></thead>
  <tbody>
    {#each rows as r (r.key)}
      <tr><td>{r.key}</td><td class="tabular-nums">{r.a}</td><td class="tabular-nums">{r.b}</td><td class="tabular-nums {r.tone}">{r.change}</td></tr>
    {/each}
  </tbody>
</table>
