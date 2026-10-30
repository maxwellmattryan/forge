// One open of the settings modal: the config form's data and drafts, and the Diagnostics and
// About fetches. settings/SettingsModal.svelte creates one per open, so drafts survive tab switches and are
// gone once the modal closes.
import { fetchAbout, fetchConfig, fetchDoctor, postConfig } from '../core/app.svelte.ts';
import { changedKeys, invalidKeys, parseDraft, type Draft } from './config-form.ts';
import type { AboutResponse, ConfigResponse, ConfigValue, DoctorResponse } from '../core/types.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SettingsSession {
  config = $state.raw<ConfigResponse | null>(null);
  configError = $state<string | null>(null);
  configLoading = $state(false);
  drafts = $state<Record<string, Draft>>({});
  /** The server's refusal for a key, from the last Save. */
  saveErrors = $state<Record<string, string>>({});
  saving = $state(false);
  /** The key the last Save stopped at, shown in the Save bar wherever the person is. */
  failedKey = $state<string | null>(null);

  doctor = $state.raw<DoctorResponse | null>(null);
  doctorError = $state<string | null>(null);
  doctorRunning = $state(false);
  doctorAsked = false;

  about = $state.raw<AboutResponse | null>(null);
  aboutError = $state<string | null>(null);
  aboutLoading = $state(false);
  aboutAsked = false;

  get changed(): string[] {
    return this.config ? changedKeys(this.config.fields, this.config.values, this.drafts) : [];
  }

  get invalid(): string[] {
    return this.config ? invalidKeys(this.config.fields, this.drafts) : [];
  }

  /** Anything a close would throw away. */
  get dirty(): boolean {
    return this.changed.length > 0 || this.invalid.length > 0;
  }

  async loadConfig(): Promise<void> {
    this.configLoading = true;
    try {
      this.config = await fetchConfig();
      this.configError = null;
    } catch (e) {
      this.configError = message(e);
    } finally {
      this.configLoading = false;
    }
  }

  setDraft(key: string, d: Draft): void {
    this.drafts[key] = d;
    delete this.saveErrors[key];
    if (this.failedKey === key) this.failedKey = null;
  }

  reset(): void {
    this.drafts = {};
    this.saveErrors = {};
    this.failedKey = null;
  }

  /** Keys with something to look at: an unsaved change, an invalid draft or a refused save. */
  get flagged(): { changed: string[]; errors: string[] } {
    return { changed: this.changed, errors: [...new Set([...this.invalid, ...Object.keys(this.saveErrors)])] };
  }

  /**
   * One POST per changed key, in field order, stopping at the first refusal. Saved keys lose
   * their drafts; the config is fetched again either way.
   */
  async save(): Promise<{ saved: number; total: number; failed: string | null }> {
    const config = this.config;
    const keys = this.changed;
    if (!config || !keys.length || this.saving) return { saved: 0, total: 0, failed: null };
    this.saving = true;
    this.failedKey = null;
    let saved = 0;
    let failed: string | null = null;
    try {
      for (const key of keys) {
        const field = config.fields.find((f) => f.key === key);
        const parsed = field ? parseDraft(field, this.drafts[key]) : null;
        if (!parsed?.ok) {
          failed = key;
          break;
        }
        try {
          await postConfig(key, parsed.value as ConfigValue);
          delete this.drafts[key];
          saved++;
        } catch (e) {
          this.saveErrors[key] = message(e);
          failed = key;
          break;
        }
      }
    } finally {
      this.saving = false;
    }
    this.failedKey = failed;
    await this.loadConfig();
    return { saved, total: keys.length, failed };
  }

  async runDoctor(): Promise<void> {
    this.doctorAsked = true;
    this.doctorRunning = true;
    try {
      this.doctor = await fetchDoctor();
      this.doctorError = null;
    } catch (e) {
      this.doctorError = message(e);
    } finally {
      this.doctorRunning = false;
    }
  }

  async loadAbout(): Promise<void> {
    if (this.aboutAsked) return;
    this.aboutAsked = true;
    this.aboutLoading = true;
    try {
      this.about = await fetchAbout();
      this.aboutError = null;
    } catch (e) {
      this.aboutError = message(e);
      this.aboutAsked = false;
    } finally {
      this.aboutLoading = false;
    }
  }
}
