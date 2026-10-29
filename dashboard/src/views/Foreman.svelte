<!-- Foreman: the page header, then the chats with the Foreman (ChatsPanel). The Office (mandates, gate runs, directives and
     the office session) is its own page, views/Office.svelte. The page is project-owned: App's {#key} remounts it. -->
<script lang="ts">
  import ChatsPanel from '../components/chats/ChatsPanel.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { t } from '../lib/text/locale.ts';
</script>

<PageHeader title={$t('foreman.title')}>
  {#snippet sub()}{$t('foreman.sub')}{/snippet}
</PageHeader>
<ChatsPanel />
