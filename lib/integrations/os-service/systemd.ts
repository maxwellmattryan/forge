// Linux's systemd user unit for the machine dashboard: the unit file, its reader, and the
// `systemctl --user` argv that enables, disables and inspects it.
import path from 'node:path';
import type { ServiceUnit } from './types.ts';

/** The user unit's name. */
export const SYSTEMD_UNIT = 'forge-dash.service';

/** `<XDG_CONFIG_HOME>/systemd/user/forge-dash.service`, with `<home>/.config` when XDG_CONFIG_HOME is unset or relative (the XDG spec ignores a relative one). */
export function systemdUnitFile(userHome: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const config = xdg && path.isAbsolute(xdg) ? xdg : path.join(userHome, '.config');
  return path.join(config, 'systemd', 'user', SYSTEMD_UNIT);
}

/** A newline would start another directive, so callers refuse control characters before rendering. */
const CONTROL = /[\u0000-\u001f\u007f]/;

function checked(s: string): string {
  if (CONTROL.test(s)) throw new Error('a systemd unit value holds a control character');
  return s;
}

/** `%` starts a specifier wherever systemd expands them (every setting written here). */
const specifiers = (s: string): string => s.replace(/%/g, '%%');

/** One ExecStart word: double-quoted, `\` and `"` backslash-escaped, `%` and `$` doubled (ExecStart expands both). */
const word = (s: string): string => `"${specifiers(checked(s).replace(/[\\"]/g, (c) => `\\${c}`)).replace(/\$/g, '$$$$')}"`;

/**
 * One Environment= assignment, quoted as a whole. Environment= expands specifiers but not variables
 * ("$" has no special meaning there, systemd.exec(5)), so `$` stays single: doubling it would change the value.
 */
const assignment = (k: string, v: string): string => `"${specifiers(`${checked(k)}=${checked(v)}`.replace(/[\\"]/g, (c) => `\\${c}`))}"`;

/**
 * The unit for `unit`: started with the user's session (default.target), restarted RestartSec seconds
 * after a non-zero exit or a signal (Restart=on-failure) but never after a clean exit, stdout and stderr
 * appended to the log. Every value is quoted and escaped; a control character throws.
 */
export function renderSystemdUnit(unit: ServiceUnit): string {
  return [
    '[Unit]',
    'Description=Forge machine dashboard (forge dash)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unit.program.map(word).join(' ')}`,
    `WorkingDirectory=${specifiers(checked(unit.workingDirectory))}`,
    ...Object.keys(unit.env)
      .sort()
      .map((k) => `Environment=${assignment(k, unit.env[k]!)}`),
    'Restart=on-failure',
    'RestartSec=30',
    `StandardOutput=append:${specifiers(checked(unit.log))}`,
    `StandardError=append:${specifiers(checked(unit.log))}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * The ExecStart words of a unit renderSystemdUnit wrote, unquoted; null when there is no ExecStart= line
 * or it holds anything but double-quoted words. One pass over the line's characters.
 */
export function readSystemdProgram(text: string): string[] | null {
  const line = text.split('\n').find((l) => l.startsWith('ExecStart='));
  if (line === undefined) return null;
  const s = line.slice('ExecStart='.length).replace(/\r$/, '');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      i++;
      continue;
    }
    if (s[i] !== '"') return null;
    let w = '';
    i++;
    for (;;) {
      if (i >= s.length) return null;
      const c = s[i]!;
      if (c === '\\') {
        if (i + 1 >= s.length) return null;
        w += s[i + 1];
        i += 2;
      } else if (c === '"') {
        i++;
        break;
      } else {
        w += c;
        i++;
      }
    }
    if (i < s.length && s[i] !== ' ') return null;
    out.push(w.replace(/%%/g, '%').replace(/\$\$/g, '$'));
  }
  return out.length ? out : null;
}

const ctl = (...args: string[]): string[] => ['systemctl', '--user', ...args];

/**
 * The `systemctl --user` argv for each action. `uninstall` runs before the unit file is removed and
 * `afterUninstall` once it is gone; `restart` follows an install that replaced a unit, since
 * `enable --now` leaves a running service on its old ExecStart.
 */
export function systemdSteps(): { install: string[][]; restart: string[][]; uninstall: string[][]; afterUninstall: string[][]; status: string[][] } {
  return {
    install: [ctl('daemon-reload'), ctl('enable', '--now', SYSTEMD_UNIT)],
    restart: [ctl('try-restart', SYSTEMD_UNIT)],
    uninstall: [ctl('disable', '--now', SYSTEMD_UNIT)],
    afterUninstall: [ctl('daemon-reload')],
    status: [ctl('is-active', SYSTEMD_UNIT)],
  };
}
