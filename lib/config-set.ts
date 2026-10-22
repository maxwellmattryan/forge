// `forge config set` and POST /api/config: the one write path for a single config key.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.ts';
import { ConfigSetError, fieldFor, validateFieldValue } from './config-fields.ts';
import { logRepoEvent } from './jobs.ts';
import { exists, paths } from './paths.ts';
import type { ConfigValue, EventActor, PostConfigResponse } from './types.ts';
import { getPath } from './shape.ts';
import { withLock, writeTextAtomic } from './util.ts';
import * as yaml from './yaml.ts';

/** The lock every writer of .forge/config.yml takes: `forge config set`, `init write`, `migrate`. */
export const configLock = (root: string): string => path.join(paths(root).locks, 'config');

export const NEED_INIT = 'this repo has no .forge/config.yml yet; run `/forge init` (or `forge init write --answers FILE`)';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Writes one editable key of .forge/config.yml, keeping every comment and the key order. The
 * shared write path of `forge config set` and POST /api/config: `value` is already typed.
 * Refuses (and leaves the file untouched) an unknown or read-only key, an invalid value, a
 * layout setIn can't edit safely, and a result with problems validateConfig didn't report before.
 * A change is recorded in the repo audit log with `actor()`, which is called only then, so an
 * unchanged value never resolves who asked.
 */
export function setConfigValue(root: string, key: string, value: ConfigValue, actor: () => EventActor): PostConfigResponse {
  const p = paths(root);
  const field = fieldFor(key);
  const invalid = validateFieldValue(field, value);
  if (invalid) throw new ConfigSetError('invalid', invalid);
  // Checked before the lock too, so a repo without Forge gets no .forge/locks/.
  if (!exists(p.config)) throw new ConfigSetError('uninitialized', NEED_INIT);
  return withLock(configLock(root), () => {
    let text: string;
    try {
      text = fs.readFileSync(p.config, 'utf8');
    } catch (e) {
      if ((e as any).code === 'ENOENT') throw new ConfigSetError('uninitialized', NEED_INIT);
      throw e;
    }
    const before = loadConfig(root, { text }).config;
    const previous = getPath(before, key);
    if (same(previous, value)) return { ok: true, key, value, previous, changed: false };
    let next: string;
    try {
      next = yaml.setIn(text, key.split('.'), value);
    } catch (e) {
      if (e instanceof yaml.YamlError) throw new ConfigSetError('unsupported-yaml', `can't set ${key}: ${e.message}; edit .forge/config.yml by hand`);
      throw e;
    }
    const after = loadConfig(root, { text: next }).config;
    if (!same(getPath(after, key), value)) throw new ConfigSetError('unsupported-yaml', `can't set ${key}: the file would not read back the new value; edit .forge/config.yml by hand`);
    const had = new Set(validateConfig(before, root));
    const added = validateConfig(after, root).filter((x) => !had.has(x));
    if (added.length) throw new ConfigSetError('invalid', `${key}: the config would be invalid: ${added.join('; ')}`);
    writeTextAtomic(p.config, next);
    logRepoEvent(root, 'config-set', { key, previous: previous ?? null, value, changed: true, actor: actor() });
    return { ok: true, key, value, previous, changed: true };
  });
}
