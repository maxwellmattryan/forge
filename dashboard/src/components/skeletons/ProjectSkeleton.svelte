<!-- The Project view's shape while the project's first state loads (App.svelte). -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import PageHeader from '../PageHeader.svelte';
  import ProjectEnvironmentsSkeleton from './ProjectEnvironmentsSkeleton.svelte';
  import ProjectGraphSkeleton from './ProjectGraphSkeleton.svelte';
  import { t } from '../../lib/text/locale.ts';
</script>

<Loading>
  <PageHeader title={$t('project.title')}>
    {#snippet sub()}{$t('project.sub')}{/snippet}
  </PageHeader>
  <section class="mb-6">
    <h2 class="plate h section w-fit max-w-full px-3 py-1.5 mb-3">{$t('project.environments.title')}</h2>
    <ProjectEnvironmentsSkeleton />
  </section>
  <ProjectGraphSkeleton />
</Loading>
