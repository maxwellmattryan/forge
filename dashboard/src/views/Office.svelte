<!-- Office: the page header, then OfficePanel. Where the view is wide enough for OfficePanel's two columns (a 56rem
     container), the page takes exactly the viewport's height left by the view's padding and the status bar, so nothing
     scrolls the page: the left column and the office log scroll on their own. Narrower, the columns stack and the page
     scrolls as any other. The page is project-owned: App's {#key} remounts it. -->
<script lang="ts">
  import OfficePanel from '../components/OfficePanel.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { OFFICE_PAGE } from '../lib/office/layout.ts';
  import { t } from '../lib/text/locale.ts';
</script>

<div class={OFFICE_PAGE}>
  <PageHeader title={$t('foreman.office.title')}>
    {#snippet sub()}{$t('foreman.office.sub')}{/snippet}
  </PageHeader>
  <OfficePanel />
</div>
