<!-- The Evals compare result: config and version line, then one row per metric. -->
<script lang="ts">
  import { compareRows } from '../lib/metrics/analytics.ts';
  import type { EvalCompare } from '../lib/core/types.ts';
  import { t } from '../lib/text/locale.ts';

  let { result: c }: { result: EvalCompare } = $props();
  const rows = $derived(compareRows(c));
</script>

<!-- No sheet of its own: it sits inside the Evals compare sheet. -->
<div class="caption muted mono mt-3">{$t('compare.summary', { a: c.a.configHash, b: c.b.configHash, va: c.a.forgeVersion, vb: c.b.forgeVersion })}</div>
<div class="overflow-x-auto mt-2">
  <table class="tbl">
    <thead><tr><th>{$t('compare.metric')}</th><th>{$t('compare.a')}</th><th>{$t('compare.b')}</th><th>Δ</th></tr></thead>
    <tbody>
      {#each rows as r (r.key)}
        <tr><td>{r.key}</td><td class="num">{r.a}</td><td class="num">{r.b}</td><td class="num {r.tone}">{r.change}</td></tr>
      {/each}
    </tbody>
  </table>
</div>
