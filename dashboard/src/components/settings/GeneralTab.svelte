<!-- Settings › General: the dashboard's appearance, language and keyboard, kept per browser. -->
<script lang="ts">
  import Select from '../Select.svelte';
  import { CATALOGS, locale, setLocale, t } from '../../lib/text/locale.ts';
  import { THEME_CHOICES, chooseTheme, currentGrain, currentScreen, setGrain, setScreen, themeChoice, type ThemeChoice } from '../../lib/ui/theme.ts';
  import { pref } from '../../lib/settings/prefs.ts';
  import { settingsShortcutLabel } from '../../lib/settings/modal.ts';
  import { slideMarker } from '../../lib/ui/marker.ts';

  let choice = $state<ThemeChoice>(themeChoice(pref.get('theme', '')));
  let grain = $state(currentGrain());
  let screen = $state(currentScreen());
  const key = settingsShortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  const codes = Object.keys(CATALOGS);
  const labels = $derived<Record<ThemeChoice, string>>({ forge: $t('settings.general.forge'), ash: $t('settings.general.ash'), temper: $t('settings.general.temper'), crucible: $t('settings.general.crucible'), patina: $t('settings.general.patina'), obsidian: $t('settings.general.obsidian'), system: $t('settings.general.system') });

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
      <div role="radiogroup" aria-labelledby="settings-theme-label" class="seg slide-marker flex-wrap gap-y-2 self-start" {@attach slideMarker('.sel', 'fill')}>
        {#each THEME_CHOICES as c (c)}<label class={choice === c ? 'btn sm sel' : 'btn sm'}><input type="radio" class="sr-only" name="settings-theme" value={c} checked={choice === c} onchange={() => pick(c)} />{#if c !== 'system'}<span data-theme={c} class="swatch" aria-hidden="true"><span></span><span></span><span></span></span>{/if}{labels[c]}</label>{/each}
      </div>
      <div id="settings-grain-label">{$t('settings.general.grain')}</div>
      <label class="field"><input type="checkbox" class="check" checked={grain} aria-labelledby="settings-grain-label" aria-describedby="settings-grain-hint" onchange={(e) => { grain = e.currentTarget.checked; setGrain(grain); }} /><span id="settings-grain-hint" class="muted">{$t('settings.general.grainHint')}</span></label>
      <div id="settings-screen-label">{$t('settings.general.screen')}</div>
      <label class="field"><input type="checkbox" class="check" checked={screen} aria-labelledby="settings-screen-label" aria-describedby="settings-screen-hint" onchange={(e) => { screen = e.currentTarget.checked; setScreen(screen); }} /><span id="settings-screen-hint" class="muted">{$t('settings.general.screenHint')}</span></label>
    </div>
  </section>
  <section class="flex flex-col gap-3">
    <h3 class="label callout">{$t('settings.general.languageKeyboard')}</h3>
    <div class="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-x-5 gap-y-3 sm:items-center">
      <label for="settings-locale">{$t('settings.general.language')}</label>
      <Select id="settings-locale" class="self-start justify-self-start" value={$locale} options={codes.map((code) => ({ value: code, label: languageName(code), lang: code }))} onchange={setLocale} />
      <p class="sm:col-span-2 caption muted">{$t('settings.general.hint', { key })}</p>
    </div>
  </section>
</div>
