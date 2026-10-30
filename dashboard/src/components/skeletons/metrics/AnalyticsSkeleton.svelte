<!-- The Analytics view's shape while the project's first state loads (App.svelte). -->
<script lang="ts">
  import Loading from '../../ui/feedback/Loading.svelte';
  import Skeleton from '../../ui/feedback/Skeleton.svelte';
  import PageHeader from '../../shell/PageHeader.svelte';
  import AnalyticsPeriodMeterSkeleton from './AnalyticsPeriodMeterSkeleton.svelte';
  import AnalyticsStatsSkeleton from './AnalyticsStatsSkeleton.svelte';
  import { t } from '../../../lib/text/locale.ts';
</script>

<Loading>
  <PageHeader title={$t('analytics.title')}>
    {#snippet sub()}{$t('analytics.sub')}{/snippet}
    {#snippet right()}<Skeleton w="8rem" h="2rem" />{/snippet}
  </PageHeader>
  <AnalyticsPeriodMeterSkeleton bare />
  <AnalyticsStatsSkeleton bare />
</Loading>
