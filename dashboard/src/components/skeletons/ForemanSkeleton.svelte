<!-- The Foreman view's shape while the project's first state loads (App.svelte): the header, then the chat list beside
     the open chat, as ChatsPanel lays them out. -->
<script lang="ts">
  import Loading from '../Loading.svelte';
  import PageHeader from '../PageHeader.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { t } from '../../lib/locale.ts';
</script>

<Loading>
  <PageHeader title={$t('foreman.title')}>
    {#snippet sub()}{$t('foreman.sub')}{/snippet}
  </PageHeader>
  <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
    <div class="plate flat flex flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-line px-3 py-2"><h2 class="h section">{$t('foreman.chats.list')}</h2><Skeleton w="5.5rem" h="1.75rem" /></div>
      <div class="flex flex-col gap-2 px-3 py-3"><Skeleton w="80%" h="0.8rem" /><Skeleton w="40%" h="0.7rem" /><Skeleton w="65%" h="0.8rem" /><Skeleton w="35%" h="0.7rem" /></div>
    </div>
    <div class="plate flex flex-col gap-2 p-4"><Skeleton w="40%" h="1.25rem" /><Skeleton w="85%" h="0.8rem" /><Skeleton w="60%" h="0.8rem" /></div>
  </div>
</Loading>
