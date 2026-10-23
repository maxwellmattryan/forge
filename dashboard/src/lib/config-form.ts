// The settings form's model: field values as editable drafts, drafts parsed back into config
// values, and which keys a Save would write. Errors are message keys, in messages/en/settings.json.
import type { ConfigField, ConfigSection, ConfigValue } from './types.ts';

/** A control's raw state: text for inputs and selects, a flag for checkboxes, the ticked options for a checkbox group. */
export type Draft = string | boolean | string[];

export type Parsed = { ok: true; value: ConfigValue } | { ok: false; error: string; params?: Record<string, string | number> };

const MAX_STRING = 200;

export const fieldsFor = (fields: ConfigField[], section: ConfigSection): ConfigField[] => fields.filter((f) => f.section === section);

/** The draft a control starts from for `value`. */
export function draftOf(f: ConfigField, value: unknown): Draft {
  if (f.type === 'boolean') return value === true;
  if (f.type === 'list') {
    const items = Array.isArray(value) ? value.map(String) : [];
    return f.options ? f.options.filter((o) => items.includes(o)) : items.join('\n');
  }
  if (f.type === 'object') return JSON.stringify(value ?? null, null, 2);
  return value === null || value === undefined ? '' : String(value);
}

/** The value a draft stands for, or the message key (messages/en/settings.json) of why it is invalid. */
export function parseDraft(f: ConfigField, draft: Draft): Parsed {
  switch (f.type) {
    case 'boolean':
      return { ok: true, value: draft === true };
    case 'integer':
    case 'number': {
      const s = String(draft).trim();
      if (!s) return f.nullable ? { ok: true, value: null } : { ok: false, error: 'settings.form.required' };
      if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: f.type === 'integer' ? 'settings.form.integer' : 'settings.form.number' };
      const n = Number(s);
      if (f.type === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'settings.form.integer' };
      if (f.min !== null && f.minExclusive && n <= f.min) return { ok: false, error: 'settings.form.greater', params: { min: f.min } };
      if (f.min !== null && n < f.min) return { ok: false, error: 'settings.form.min', params: { min: f.min } };
      if (f.max !== null && n > f.max) return { ok: false, error: 'settings.form.max', params: { max: f.max } };
      return { ok: true, value: n };
    }
    case 'enum': {
      const s = String(draft);
      // A nullable enum's "Not set" option is the empty value.
      if (!s && f.nullable) return { ok: true, value: null };
      return (f.options ?? []).includes(s) ? { ok: true, value: s } : { ok: false, error: 'settings.form.option' };
    }
    case 'list': {
      const items = Array.isArray(draft) ? draft : String(draft).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const bad = f.options ? items.find((x) => !f.options?.includes(x)) : undefined;
      if (bad !== undefined) return { ok: false, error: 'settings.form.listOption', params: { item: bad } };
      const missing = (f.required ?? []).filter((r) => !items.includes(r));
      if (missing.length) return { ok: false, error: 'settings.form.listRequired', params: { items: missing.join(', ') } };
      const long = items.find((x) => x.length > MAX_STRING);
      if (long !== undefined) return { ok: false, error: 'settings.form.tooLong', params: { max: MAX_STRING } };
      return { ok: true, value: items };
    }
    case 'string': {
      const s = String(draft).trim();
      if (!s) return f.nullable ? { ok: true, value: null } : { ok: false, error: 'settings.form.required' };
      if (s.length > MAX_STRING) return { ok: false, error: 'settings.form.tooLong', params: { max: MAX_STRING } };
      return { ok: true, value: s };
    }
    default:
      return { ok: false, error: 'settings.form.readOnly' };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Editable fields, in field order, whose draft parses to something other than the current value. */
export function changedKeys(fields: ConfigField[], values: Record<string, unknown>, drafts: Record<string, Draft>): string[] {
  return fields
    .filter((f) => f.editable && Object.hasOwn(drafts, f.key))
    .filter((f) => {
      const p = parseDraft(f, drafts[f.key]);
      return p.ok && !same(p.value, values[f.key]);
    })
    .map((f) => f.key);
}

/** Editable fields with a draft that doesn't parse. */
export function invalidKeys(fields: ConfigField[], drafts: Record<string, Draft>): string[] {
  return fields.filter((f) => f.editable && Object.hasOwn(drafts, f.key) && !parseDraft(f, drafts[f.key]).ok).map((f) => f.key);
}

/** A config value as the form shows it; null for "no value". */
export function formatValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    // A list of maps (review.panel) as JSON, not "[object Object]".
    return v.some((x) => x && typeof x === 'object') ? JSON.stringify(v) : v.map(String).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}
