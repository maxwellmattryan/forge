<!-- The Issues view's shape while the project's first state loads (App.svelte). -->
<script lang="ts">
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import IssuesTableSkeleton from './IssuesTableSkeleton.svelte';
  import { t } from '../../lib/locale.ts';
</script>

<PageHeader title={$t('issues.title')}>
  {#snippet sub()}<Skeleton w="11rem" h="0.6875rem" class="inline-block" />{/snippet}
  {#snippet right()}<Skeleton w="6rem" h="2rem" /><Skeleton w="6rem" h="2rem" />{/snippet}
</PageHeader>
<IssuesTableSkeleton />
