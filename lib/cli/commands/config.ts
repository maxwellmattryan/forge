// `forge config show|get|set|validate`: read the effective config, and write one editable key.
import { validateConfig } from '#core/config/load.ts';
import { fieldFor, parseCliValue } from '#core/config/fields.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { NEED_INIT, setConfigValue } from '#core/config/set.ts';
import type { Config, HelpGroup } from '#core/types.ts';
import { getPath } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { out, req, usageError } from './args.ts';

const CONFIG: HelpGroup = {
  name: 'config',
  summary: 'read, check and change .forge/config.yml',
  commands: [
    { command: 'config show', args: '', summary: 'the effective config (defaults merged with the file), indented' },
    {
      command: 'config get',
      args: '[<key>]',
      summary: 'read the effective config: one dotted key (strings raw, null when absent), or all of it',
      docs: ['Changing settings', 'docs/CONFIG.md#changing-settings'],
      readme: true,
    },
    {
      command: 'config set',
      args: '<key> <value>',
      summary: 'change one editable key in `.forge/config.yml`, keeping its comments',
      exits: [[1, 'an unknown or read-only key, an invalid value, or a layout the edit cannot keep']],
      docs: ['Changing settings', 'docs/CONFIG.md#changing-settings'],
      readme: true,
    },
    { command: 'config validate', args: '', summary: 'check the config; prints the problems', exits: [[1, 'the config has problems']] },
  ],
};

export const HELP: HelpGroup[] = [CONFIG];

export function configCmd(root: string, config: Config, initialized: boolean, sub: string | undefined, rest: string[], flags: Record<string, any>): void {
  if (!sub || sub === 'show') return out(config, { ...flags, pretty: true });
  if (sub === 'get') return out(getPath(config, rest[0] ?? '') ?? null, flags);
  if (sub === 'set') {
    if (!initialized) throw new ForgeError(NEED_INIT, 'not_initialized', '/forge init');
    const key = req(rest[0], 'config key');
    if (rest[1] === undefined) throw usageError(CONFIG, 'set');
    return out(setConfigValue(root, key, parseCliValue(fieldFor(key), rest[1]), () => currentActor(root)), flags);
  }
  if (sub === 'validate') {
    const problems = validateConfig(config, root);
    out({ ok: !problems.length, initialized, problems }, flags);
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw usageError(CONFIG);
}
