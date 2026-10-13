<!-- Settings › General: the dashboard's language and theme, kept per browser. -->
<script lang="ts">
  import { CATALOGS, locale, setLocale, t } from '../../lib/locale.ts';
  import { currentTheme, setTheme, type Theme } from '../../lib/theme.ts';

  let theme = $state<Theme>(currentTheme());
  const codes = Object.keys(CATALOGS);

  function languageName(code: string): string {
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  function pick(next: Theme): void {
    setTheme(next);
    theme = next;
  }
</script>

<div class="p-4 md:p-6 flex flex-col gap-6">
  <div class="flex flex-col gap-1.5">
    <label for="settings-locale" class="text-sm font-medium">{$t('settings.general.language')}</label>
    <select id="settings-locale" class="self-start" value={$locale} onchange={(e) => setLocale(e.currentTarget.value)}>
      {#each codes as code (code)}<option value={code}>{languageName(code)}</option>{/each}
    </select>
  </div>
  <div class="flex flex-col gap-1.5">
    <div id="settings-theme-label" class="text-sm font-medium">{$t('settings.general.theme')}</div>
    <div role="radiogroup" aria-labelledby="settings-theme-label" class="flex flex-wrap gap-2">
      <label class="btn min-h-11 {theme === 'light' ? 'border-accent/60 text-fg' : 'text-muted'}"><input type="radio" name="settings-theme" value="light" checked={theme === 'light'} onchange={() => pick('light')} />{$t('settings.general.light')}</label>
      <label class="btn min-h-11 {theme === 'dark' ? 'border-accent/60 text-fg' : 'text-muted'}"><input type="radio" name="settings-theme" value="dark" checked={theme === 'dark'} onchange={() => pick('dark')} />{$t('settings.general.dark')}</label>
    </div>
  </div>
  <p class="text-xs text-muted">{$t('settings.general.hint')}</p>
</div>
