// ANSI styles and terminal-safe text for human output. A leaf below the CLI layer, so the activity
// feed (lib/cli/activity.ts) and the renderers in lib/cli/commands/ share it.

export type Style = (s: string) => string;

export type Paint = { bold: Style; dim: Style; red: Style; green: Style; yellow: Style; cyan: Style };

/** One ANSI style from its SGR parameters (`1;36` is bold cyan), the identity when colour is off. */
export function sgr(on: boolean, code: string): Style {
  return on ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s;
}

/** ANSI styles, each the identity when colour is off, so callers never branch on it. */
export function paint(on: boolean): Paint {
  return { bold: sgr(on, '1'), dim: sgr(on, '2'), red: sgr(on, '31'), green: sgr(on, '32'), yellow: sgr(on, '33'), cyan: sgr(on, '36') };
}

const hex = (c: string, width: number): string => c.charCodeAt(0).toString(16).padStart(width, '0');

/**
 * Rendered text can come from tracker issues, PR comments and agent-written job state, so every
 * control a terminal acts on is shown as a visible escape: OSC 52 clipboard writes, title changes,
 * cursor moves and carriage returns could otherwise hide or forge lines. Only `\n` survives.
 * The set matches the title sanitising in lib/office/notify.ts, which deletes rather than escapes.
 */
export function sanitize(s: string): string {
  return s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${hex(c, 2)}`).replace(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, (c) => `\\u${hex(c, 4)}`);
}
