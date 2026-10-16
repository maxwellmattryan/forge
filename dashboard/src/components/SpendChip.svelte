<!-- The status bar's month spend chip: `$12.34 / $100` against the month cap, `$12.34 this month` without one, toned warn
     from 80% and bad once a cap is reached. It links to Analytics, where the period meter has the detail. -->
<script lang="ts">
  import type { RepoBudgetStatus } from '../lib/types.ts';
  import { TONE_MOD, chipModel } from '../lib/repo-budget.ts';
  import { t } from '../lib/locale.ts';

  let { budget, extra = '' }: { budget: RepoBudgetStatus; extra?: string } = $props();
  const c = $derived(chipModel(budget));
</script>

<a class="btn sm ghost {extra}" href="#/analytics" title={$t('budget.chipTitle')}>
  <span class="chip sm num {TONE_MOD[c.tone]}">{c.capped ? $t('budget.chipCapped', { spent: c.spent, cap: c.cap }) : $t('budget.chipUncapped', { spent: c.spent })}</span>
</a>
