// The settings modal's plain-TS helpers and the i18n lookup (dashboard/src/lib), imported straight
// from source: they have no svelte or DOM dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_LOCALE, pickLocale, translate } from '../dashboard/src/lib/i18n.ts';

test('i18n translate and pickLocale', () => {
  const catalogs = {
    en: { nav: { pipeline: 'Pipeline' }, hello: 'Hello {name}, {missing}', jobs: { one: '{count} job', other: '{count} jobs' }, only: 'English only' },
    de: { nav: { pipeline: 'Pipeline (de)' }, jobs: { one: '{count} Job', other: '{count} Jobs' } },
  };
  assert.equal(SOURCE_LOCALE, 'en');
  assert.equal(translate('en', catalogs, 'nav.pipeline'), 'Pipeline', 'nested keys');
  assert.equal(translate('en', catalogs, 'hello', { name: 'Ada' }), 'Hello Ada, {missing}', 'interpolates and leaves unknown placeholders');
  assert.equal(translate('en', catalogs, 'jobs', { count: 1 }), '1 job');
  assert.equal(translate('en', catalogs, 'jobs', { count: 2 }), '2 jobs');
  assert.equal(translate('en', catalogs, 'jobs', { count: 0 }), '0 jobs');
  assert.equal(translate('en', catalogs, 'jobs'), '{count} jobs', 'no count: other');
  assert.equal(translate('de', catalogs, 'jobs', { count: 1 }), '1 Job');
  assert.equal(translate('de', catalogs, 'only'), 'English only', 'a missing key falls back to en');
  assert.equal(translate('fr', catalogs, 'nav.pipeline'), 'Pipeline', 'a missing locale falls back to en');
  assert.equal(translate('en', catalogs, 'nope.key'), 'nope.key', 'missing everywhere: the key');
  assert.equal(translate('en', catalogs, 'nav'), 'nav', 'a branch is not a message');

  assert.equal(pickLocale('de', ['en-US'], ['en', 'de']), 'de', 'saved wins');
  assert.equal(pickLocale('xx', ['de-AT', 'en'], ['en', 'de']), 'de', 'then navigator, by base language');
  assert.equal(pickLocale('', ['en-GB'], ['en']), 'en', 'en-GB matches en');
  assert.equal(pickLocale(null, ['ja'], ['en', 'de']), 'en', 'else en');
});
