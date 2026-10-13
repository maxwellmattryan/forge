// `forge config show|get|set|validate`: read the effective config, and write one editable key.
import { NEED_INIT, setConfigValue, validateConfig } from '../config.ts';
import { fieldFor, parseCliValue } from '../config-fields.ts';
import type { Config } from '../types.ts';
import { ForgeError, getPath } from '../util.ts';
import { out, req } from './args.ts';

export function configCmd(root: string, config: Config, initialized: boolean, sub: string | undefined, rest: string[], flags: Record<string, any>): void {
  if (!sub || sub === 'show') return out(config, { ...flags, pretty: true });
  if (sub === 'get') return out(getPath(config, rest[0] ?? '') ?? null, flags);
  if (sub === 'set') {
    if (!initialized) throw new ForgeError(NEED_INIT, 2);
    const key = req(rest[0], 'config key');
    if (rest[1] === undefined) throw new ForgeError('usage: forge config set PATH VALUE');
    return out(setConfigValue(root, key, parseCliValue(fieldFor(key), rest[1])), flags);
  }
  if (sub === 'validate') {
    const problems = validateConfig(config, root);
    out({ ok: !problems.length, initialized, problems }, flags);
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw new ForgeError('usage: forge config [show|get PATH|set PATH VALUE|validate]');
}
