// macOS's per-user LaunchAgent for the machine dashboard: the plist file, its reader, and the
// launchctl argv that loads, unloads and inspects it in the user's GUI domain.
import path from 'node:path';
import type { ServiceUnit } from './types.ts';

/** The LaunchAgent's label, which is also its file name: Forge's reverse-DNS name. */
export const LAUNCHD_LABEL = 'io.github.maxwellmattryan.forge.dash';

/** `<home>/Library/LaunchAgents/<label>.plist`: the per-user agents launchd loads at login. */
export function launchAgentFile(userHome: string): string {
  return path.join(userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, k]));

/** XML 1.0 has no form for most control characters, and a newline here could be read as another key: callers refuse them first. */
const CONTROL = /[\u0000-\u001f\u007f]/;

function xml(s: string): string {
  if (CONTROL.test(s)) throw new Error('a LaunchAgent value holds a control character');
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const unxml = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => UNESCAPES[e]!);

const str = (s: string, indent: string): string => `${indent}<string>${xml(s)}</string>`;

/**
 * The plist for `unit`: started at login (RunAtLoad), restarted ThrottleInterval seconds after a
 * crash but never after a clean exit (KeepAlive SuccessfulExit false), stdout and stderr appended to
 * the log. Every string is XML-escaped; a control character throws.
 */
export function renderLaunchAgent(unit: ServiceUnit): string {
  const env = Object.keys(unit.env)
    .sort()
    .flatMap((k) => [`    <key>${xml(k)}</key>`, str(unit.env[k]!, '    ')]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str(LAUNCHD_LABEL, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...unit.program.map((w) => str(w, '    ')),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    str(unit.workingDirectory, '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '  <key>StandardOutPath</key>',
    str(unit.log, '  '),
    '  <key>StandardErrorPath</key>',
    str(unit.log, '  '),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const PROGRAM_KEY = '<key>ProgramArguments</key>';

/**
 * The ProgramArguments array of a plist renderLaunchAgent wrote, unescaped; null when the key is
 * missing or its array holds anything but `<string>` entries. A scan with indexOf and a sticky
 * pattern, so a hostile file costs linear time.
 */
export function readLaunchAgentProgram(text: string): string[] | null {
  const k = text.indexOf(PROGRAM_KEY);
  if (k < 0) return null;
  const open = /\s*<array>/y;
  open.lastIndex = k + PROGRAM_KEY.length;
  if (!open.test(text)) return null;
  const end = text.indexOf('</array>', open.lastIndex);
  if (end < 0) return null;
  const body = text.slice(open.lastIndex, end);
  const item = /\s*<string>([^<]*)<\/string>/y;
  const out: string[] = [];
  let at = 0;
  for (let m = item.exec(body); m; m = item.exec(body)) {
    out.push(unxml(m[1]!));
    at = item.lastIndex;
  }
  return body.slice(at).trim() === '' ? out : null;
}

/** The launchctl argv for each action in the user's GUI domain (`gui/<uid>`): bootout before bootstrap, so a reinstall reloads. */
export function launchdSteps(uid: number, file: string): { install: string[][]; uninstall: string[][]; status: string[][] } {
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  return {
    install: [
      ['launchctl', 'bootout', target],
      ['launchctl', 'bootstrap', `gui/${uid}`, file],
    ],
    uninstall: [['launchctl', 'bootout', target]],
    status: [['launchctl', 'print', target]],
  };
}
