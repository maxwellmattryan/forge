<!-- Settings › General: the dashboard's language and theme, kept per browser. -->
<script lang="ts">
  import { CATALOGS, locale, setLocale, t } from '../../lib/locale.ts';
  import { currentTheme, setTheme, type Theme } from '../../lib/theme.ts';
  import { pref } from '../../lib/prefs.ts';

  let theme = $state<Theme>(currentTheme());
  let shortcut = $state(pref.get('settingsShortcut', 'on') !== 'off');
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
      {#each codes as code (code)}<option value={code} lang={code}>{languageName(code)}</option>{/each}
    </select>
  </div>
  <div class="flex flex-col gap-1.5">
    <div id="settings-theme-label" class="text-sm font-medium">{$t('settings.general.theme')}</div>
    <div role="radiogroup" aria-labelledby="settings-theme-label" class="flex flex-wrap gap-2">
      <label class="btn min-h-11 {theme === 'cyanotype' ? 'border-ink/60 text-fg' : 'text-muted'}"><input type="radio" name="settings-theme" value="cyanotype" checked={theme === 'cyanotype'} onchange={() => pick('cyanotype')} />{$t('settings.general.cyanotype')}</label>
      <label class="btn min-h-11 {theme === 'vellum' ? 'border-ink/60 text-fg' : 'text-muted'}"><input type="radio" name="settings-theme" value="vellum" checked={theme === 'vellum'} onchange={() => pick('vellum')} />{$t('settings.general.vellum')}</label>
    </div>
  </div>
  <div class="flex flex-col gap-1">
    <label class="flex items-center gap-2 text-sm font-medium min-h-8"><input type="checkbox" checked={shortcut} onchange={(e) => { shortcut = e.currentTarget.checked; pref.set('settingsShortcut', shortcut ? 'on' : 'off'); }} />{$t('settings.general.shortcut')}</label>
    <p class="text-xs text-muted">{shortcut ? $t('settings.general.hint') : $t('settings.general.hintOff')}</p>
  </div>
</div>
