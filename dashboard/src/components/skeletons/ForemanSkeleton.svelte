<!-- The Foreman view's shape while the project's first state loads (App.svelte): the header, the tab strip, then the Office
     panel's sections (session, mandates, directives) with the same headings. -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import ForemanDirectivesSkeleton from './ForemanDirectivesSkeleton.svelte';
  import ForemanMandatesSkeleton from './ForemanMandatesSkeleton.svelte';
  import { t } from '../../lib/locale.ts';
</script>

<Loading>
  <PageHeader title={$t('foreman.title')}>
    {#snippet sub()}{$t('foreman.sub')}{/snippet}
  </PageHeader>
  <div class="plate flat mb-5 px-3"><div class="tabs border-b-0!"><span class="tab active">{$t('foreman.panel.office')}</span></div></div>
  <div class="flex flex-col">
    <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('foreman.office.session')}</h2>
    <div class="plate flex flex-col gap-2 p-4"><Skeleton w="4.5rem" h="1.25rem" /><Skeleton w="70%" h="0.8rem" /><Skeleton w="45%" h="0.8rem" /></div>
    <div class="mt-8 mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="plate h section w-fit max-w-full px-3 py-1.5">{$t('foreman.office.mandates')}</h2>
      <Skeleton w="7rem" h="2rem" />
    </div>
    <ForemanMandatesSkeleton bare />
    <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mt-8 mb-3">{$t('foreman.office.directives')}</h2>
    <ForemanDirectivesSkeleton bare />
  </div>
</Loading>
