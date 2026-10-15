// Credential-shaped test values, built at runtime from a seed. No provider-shaped literal is ever
// committed (test/secrets.test.ts scans the repo for one), so prefixes are joined from parts and
// bodies come from sha256. The values are random, never real credentials.
import { createHash } from 'node:crypto';

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const ALNUM = UPPER + LOWER + DIGITS;

const join = (...parts: string[]): string => parts.join('');

/** `n` characters of `alphabet`, chosen by sha256 of the seed (and a counter once that runs out). */
export function pick(alphabet: string, n: number, seed: string): string {
  let out = '';
  for (let i = 0; out.length < n; i++) {
    for (const b of createHash('sha256').update(`${seed}:${i}`).digest()) {
      if (out.length === n) break;
      out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** An alphanumeric body with at least one upper-case letter, one lower-case letter and one digit. */
function mixed(n: number, seed: string): string {
  return pick(UPPER, 1, `${seed}/u`) + pick(LOWER, 1, `${seed}/l`) + pick(DIGITS, 1, `${seed}/d`) + pick(ALNUM, n - 3, seed);
}

export const base64Of = (seed: string): string => createHash('sha256').update(seed).digest('base64');
export const hexOf = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const DASHES = '-'.repeat(5);
/** A PEM private key block: header, `lines` of 64 base64 characters, footer. */
export function pem(seed = 'pem', lines = 4, label = 'RSA'): string {
  const body = Array.from({ length: lines }, (_, i) => pick(`${ALNUM}+/`, 64, `${seed}:${i}`));
  return [join(DASHES, 'BEG', 'IN ', label, ' PRIV', 'ATE KEY', DASHES), ...body, join(DASHES, 'EN', 'D ', label, ' PRIV', 'ATE KEY', DASHES)].join('\n');
}

/** One positive value per provider kind. */
export const token = {
  aws: (seed = 'aws') => join('AK', 'IA') + pick(UPPER + DIGITS, 16, seed),
  github: (seed = 'gh') => join('gh', 'p_') + mixed(36, seed),
  githubPat: (seed = 'pat') => join('git', 'hub_', 'pat_') + mixed(82, seed),
  gitlab: (seed = 'gl') => join('gl', 'pat-') + mixed(20, seed),
  slack: (seed = 'slack') => join('xo', 'xb-') + pick(DIGITS, 12, `${seed}1`) + '-' + mixed(24, seed),
  stripe: (seed = 'stripe') => join('sk', '_li', 've_') + mixed(24, seed),
  anthropic: (seed = 'ant') => join('sk', '-an', 't-') + 'api03-' + mixed(40, seed),
  openai: (seed = 'oai') => join('sk', '-pr', 'oj-') + mixed(40, seed),
  google: (seed = 'goog') => join('AI', 'za') + mixed(35, seed),
  bearer: (seed = 'bearer') => mixed(40, seed),
  urlPassword: (seed = 'urlpw') => mixed(24, seed),
};

/** A line that holds `value` as each provider kind expects to find it. */
export const inContext = {
  aws: (v: string) => `aws_access_key_id = ${v}`,
  bearer: (v: string) => `curl -H "Authorization: Bearer ${v}" https://api.invalid/v1`,
  urlQuery: (v: string) => `GET https://api.invalid/items?limit=5&token=${v}`,
  urlUserinfo: (v: string) => `DATABASE_URL=postgres://app:${v}@db.internal:5432/app`,
};
