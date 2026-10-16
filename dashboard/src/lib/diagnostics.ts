// The Diagnostics tab's report: plain text for the clipboard, never HTML.
import type { AboutResponse, DoctorResponse } from './types.ts';

export const failedCount = (d: DoctorResponse): number => d.checks.filter((c) => !c.ok).length;
/** Checks that passed but are worth a look: a newer release, a deprecated config key. */
export const warnCount = (d: DoctorResponse): number => d.checks.filter((c) => c.ok && c.warn).length;

const mark = (c: DoctorResponse['checks'][number]): string => (!c.ok ? 'FAIL' : c.warn ? 'warn' : 'ok');

/** `Forge v… · API … · Node …`, one `[ok]`/`[warn]`/`[FAIL]` line per check, then when it ran. */
export function doctorReport(d: DoctorResponse, about: AboutResponse | null): string {
  const head = `Forge v${about?.forgeVersion ?? '?'} · API ${about?.apiVersion ?? '?'} · Node ${about?.node ?? '?'}`;
  const lines = d.checks.map((c) => `[${mark(c)}] ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  return [head, ...lines, `Checked at ${d.at}`].join('\n');
}

export const BUNDLE_FALLBACK = 'forge-support.zip';

/**
 * The file name a support bundle download saves as: the `filename` of its Content-Disposition, or
 * forge-support.zip when there is none or it could name a path (a `/`, `\` or `..`).
 */
export function bundleFilename(header: string | null): string {
  const m = /filename="([^"]*)"|filename=([^;\s]+)/i.exec(header ?? '');
  const name = (m?.[1] ?? m?.[2] ?? '').trim();
  if (!name || /[/\\]/.test(name) || name.includes('..')) return BUNDLE_FALLBACK;
  return name;
}
