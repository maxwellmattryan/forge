<!-- The Office view's shape while the project's first state loads (App.svelte): the header, then OfficePanel's columns
     (lib/office/layout.ts) with the same headings: the mandates and directives on the left, the office session on the right. -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import ForemanDirectivesSkeleton from './ForemanDirectivesSkeleton.svelte';
  import ForemanMandatesSkeleton from './ForemanMandatesSkeleton.svelte';
  import { OFFICE_GRID, OFFICE_LEFT, OFFICE_PAGE } from '../../lib/office/layout.ts';
  import { t } from '../../lib/text/locale.ts';
</script>

<Loading class={OFFICE_PAGE}>
  <PageHeader title={$t('foreman.office.title')}>
    {#snippet sub()}{$t('foreman.office.sub')}{/snippet}
  </PageHeader>
  <div class={OFFICE_GRID}>
    <div class={OFFICE_LEFT}>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="plate h section w-fit max-w-full px-3 py-1.5">{$t('foreman.office.mandates')}</h2>
        <Skeleton w="7rem" h="2rem" />
      </div>
      <ForemanMandatesSkeleton bare />
      <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.directives')}</h2>
      <ForemanDirectivesSkeleton bare />
    </div>
    <div class="flex min-w-0 flex-col">
      <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('foreman.office.session')}</h2>
      <div class="plate flex flex-col gap-2 p-4"><Skeleton w="4.5rem" h="1.25rem" /><Skeleton w="70%" h="0.8rem" /><Skeleton w="45%" h="0.8rem" /></div>
    </div>
  </div>
</Loading>
