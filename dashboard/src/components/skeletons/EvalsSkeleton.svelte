<!-- The Evals view's shape while the project's first state loads (App.svelte). -->
<script lang="ts">
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import EvalsBodySkeleton from './EvalsBodySkeleton.svelte';
  import { t } from '../../lib/locale.ts';
</script>

<PageHeader title={$t('evals.title')}>
  {#snippet sub()}{$t('evals.sub')}{/snippet}
  {#snippet right()}<Skeleton w="4.5rem" h="2rem" />{/snippet}
</PageHeader>
<EvalsBodySkeleton />
