// secrets: validation, apart from lib/engine/guard/secret-refs.ts so lib/core/config/validate.ts can import it without pulling in
// processes or git. Mirrors lib/core/config/validators/backing.ts. Every field here reaches `security`, `secret-tool`
// or `op` as an argument, so the shapes are strict: no leading `-`, a fixed charset. A problem never
// echoes a field's value: a credential pasted where its reference belongs must not reach Settings.
import { PROTO_KEYS, isMap, kind, show } from '../../shape.ts';
import { isInsidePath } from '../../os/fs.ts';

/** Where a secret's value can come from (docs/CONFIG.md "Secret references"). */
const SECRET_SOURCES = ['env', 'keychain', 'op', 'file'] as const;
export type SecretSourceKind = (typeof SECRET_SOURCES)[number];

/** A secret's name, an env source's variable and a dotenv `key`. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A keychain service or account: 1–128 safe characters, never an option. */
const KEYCHAIN_FIELD = /^(?!-)[A-Za-z0-9._@:/ +-]{1,128}$/;
/** A 1Password secret reference. */
const OP_REF = /^op:\/\/[^\s]+$/;
const MAX_OP_REF = 500;
// PROTO_KEYS are reserved names: object keys with a meaning, where `values.__proto__ = v` drops the
// value, so it would never be redacted.
const KEYCHAIN_KEYS = new Set(['service', 'account']);

/** The one source key of a well-formed entry, or null. */
export function secretSourceOf(entry: unknown): SecretSourceKind | null {
  if (!isMap(entry)) return null;
  const keys = SECRET_SOURCES.filter((k) => entry[k] !== undefined);
  return keys.length === 1 ? keys[0] : null;
}

/** Every problem with one declared entry, labelled `secrets.<name>`. */
export function secretEntryProblems(name: string, entry: unknown): string[] {
  const at = `secrets.${SECRET_NAME.test(name) ? name : show(name, 80)}`;
  if (!isMap(entry)) return [`${at} must be a map with exactly one of ${SECRET_SOURCES.join(' | ')} (got ${kind(entry)})`];
  const problems: string[] = [];
  const sources = SECRET_SOURCES.filter((k) => entry[k] !== undefined);
  for (const k of Object.keys(entry)) if (!(SECRET_SOURCES as readonly string[]).includes(k) && k !== 'key') problems.push(`${at} has unknown key ${show(k, 80)}`);
  if (sources.length !== 1) return [...problems, `${at} must have exactly one of ${SECRET_SOURCES.join(' | ')} (got ${sources.length ? sources.join(', ') : 'none'})`];
  const src = sources[0];
  const v = entry[src];
  if (entry.key !== undefined && src !== 'file') problems.push(`${at}.key is only for a file source`);
  if (src === 'env') {
    if (typeof v !== 'string' || !SECRET_NAME.test(v)) problems.push(`${at}.env must be an environment variable name matching ${SECRET_NAME.source} (got ${kind(v)})`);
  } else if (src === 'keychain') {
    if (!isMap(v)) problems.push(`${at}.keychain must be a map with service and an optional account (got ${kind(v)})`);
    else {
      for (const k of Object.keys(v)) if (!KEYCHAIN_KEYS.has(k)) problems.push(`${at}.keychain has unknown key ${show(k, 80)}`);
      if (v.service === undefined) problems.push(`${at}.keychain.service is required`);
      for (const k of ['service', 'account'] as const)
        if (v[k] !== undefined && (typeof v[k] !== 'string' || !KEYCHAIN_FIELD.test(v[k])))
          problems.push(`${at}.keychain.${k} must be 1–128 characters of A-Z a-z 0-9 . _ @ : / space + - and must not start with - (got ${kind(v[k])})`);
    }
  } else if (src === 'op') {
    if (typeof v !== 'string' || !OP_REF.test(v) || v.length > MAX_OP_REF) problems.push(`${at}.op must be a 1Password reference op://<vault>/<item>/<field> of at most ${MAX_OP_REF} characters with no whitespace`);
  } else {
    if (!isInsidePath(v)) problems.push(`${at}.file must be a relative path inside the repo, with no .. segment (got ${kind(v)})`);
    if (entry.key !== undefined && (typeof entry.key !== 'string' || !SECRET_NAME.test(entry.key))) problems.push(`${at}.key must be a variable name matching ${SECRET_NAME.source}`);
  }
  return problems;
}

/** Every problem with `secrets`, in the form validateConfig reports. A `{secret.NAME}` naming no entry is reported by sinkProblems. */
export function secretRefProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const s = cfg.secrets;
  if (s === undefined) return [];
  if (!isMap(s)) return [`secrets must be a map of secret names to sources (got ${kind(s)})`];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(s)) {
    if (!SECRET_NAME.test(name)) problems.push(`secrets.${show(name, 80)} is not a valid secret name; it must match ${SECRET_NAME.source}`);
    else if (PROTO_KEYS.has(name)) problems.push(`secrets.${name} is reserved; choose another secret name`);
    problems.push(...secretEntryProblems(name, entry));
  }
  return problems;
}

/** The declared names of a config, for checking `{secret.NAME}` references: none when `secrets` is not a map. */
export function declaredSecrets(c: any): Set<string> {
  return new Set(isMap(c?.secrets) ? Object.keys(c.secrets).filter((n) => SECRET_NAME.test(n) && !PROTO_KEYS.has(n)) : []);
}
