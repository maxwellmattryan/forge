<!-- Settings › General: the dashboard's appearance, language and keyboard, kept per browser. -->
<script lang="ts">
  import { CATALOGS, locale, setLocale, t } from '../../lib/locale.ts';
  import { THEME_CHOICES, chooseTheme, currentDrawing, setDrawing, themeChoice, type ThemeChoice } from '../../lib/theme.ts';
  import { pref } from '../../lib/prefs.ts';

  let choice = $state<ThemeChoice>(themeChoice(pref.get('theme', '')));
  let grid = $state(currentDrawing('grid'));
  let paper = $state(currentDrawing('paper'));
  let shortcut = $state(pref.get('settingsShortcut', 'on') !== 'off');
  const codes = Object.keys(CATALOGS);
  const labels = $derived<Record<ThemeChoice, string>>({ cyanotype: $t('settings.general.cyanotype'), vellum: $t('settings.general.vellum'), nightprint: $t('settings.general.nightprint'), system: $t('settings.general.system') });

  function languageName(code: string): string {
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  function pick(c: ThemeChoice): void {
    chooseTheme(c);
    choice = c;
  }
</script>

<div class="p-4 md:p-6 flex flex-col gap-6">
  <section class="flex flex-col gap-3">
    <h3 class="label callout">{$t('settings.general.appearance')}</h3>
    <div class="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-x-5 gap-y-3 sm:items-center">
      <div id="settings-theme-label">{$t('settings.general.theme')}</div>
      <div role="radiogroup" aria-labelledby="settings-theme-label" class="seg flex-wrap gap-y-2 self-start">
        {#each THEME_CHOICES as c (c)}<label class={choice === c ? 'btn sm sel' : 'btn sm'}><input type="radio" class="sr-only" name="settings-theme" value={c} checked={choice === c} onchange={() => pick(c)} />{labels[c]}</label>{/each}
      </div>
      <div id="settings-grid-label">{$t('settings.general.grid')}</div>
      <label class="field"><input type="checkbox" class="check" checked={grid} aria-labelledby="settings-grid-label" aria-describedby="settings-grid-hint" onchange={(e) => { grid = e.currentTarget.checked; setDrawing('grid', grid); }} /><span id="settings-grid-hint" class="muted">{$t('settings.general.gridHint')}</span></label>
      <div id="settings-paper-label">{$t('settings.general.paper')}</div>
      <label class="field"><input type="checkbox" class="check" checked={paper} aria-labelledby="settings-paper-label" aria-describedby="settings-paper-hint" onchange={(e) => { paper = e.currentTarget.checked; setDrawing('paper', paper); }} /><span id="settings-paper-hint" class="muted">{$t('settings.general.paperHint')}</span></label>
    </div>
  </section>
  <section class="flex flex-col gap-3">
    <h3 class="label callout">{$t('settings.general.languageKeyboard')}</h3>
    <div class="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-x-5 gap-y-3 sm:items-center">
      <label for="settings-locale">{$t('settings.general.language')}</label>
      <select id="settings-locale" class="self-start justify-self-start" value={$locale} onchange={(e) => setLocale(e.currentTarget.value)}>
        {#each codes as code (code)}<option value={code} lang={code}>{languageName(code)}</option>{/each}
      </select>
      <div class="sm:col-span-2 flex flex-col gap-1">
        <label class="field text-sm"><input type="checkbox" class="check" checked={shortcut} onchange={(e) => { shortcut = e.currentTarget.checked; pref.set('settingsShortcut', shortcut ? 'on' : 'off'); }} />{$t('settings.general.shortcut')}</label>
        <p class="caption muted">{shortcut ? $t('settings.general.hint') : $t('settings.general.hintOff')}</p>
      </div>
    </div>
  </section>
</div>
