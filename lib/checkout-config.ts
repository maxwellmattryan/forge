// checkout: validation, apart from lib/checkout.ts so lib/config.ts can import it without pulling in
// jobs.ts (which imports config.ts). Also the one rule for where a step's `to` points.
import os from 'node:os';
import path from 'node:path';
import { isInsidePath } from './components.ts';

const isMap = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => (v === undefined ? 'nothing' : (JSON.stringify(v) ?? String(v)).slice(0, 120));

/** A step's `to` as an absolute path: a leading `~/` is the home directory, then path.resolve. */
export function resolveTarget(to: string): string {
  return path.resolve(to.startsWith('~/') ? path.join(os.homedir(), to.slice(2)) : to);
}

/** Why `to` is unusable as a fixed path, or null. */
function targetProblem(to: unknown): string | null {
  // path.isAbsolute also accepts a win32 drive or UNC path where Forge runs on Windows.
  if (typeof to !== 'string' || !(to.startsWith('/') || to.startsWith('~/') || path.isAbsolute(to))) return `must be an absolute path or start with ~/ (got ${show(to)})`;
  if (to.includes('\0')) return 'must not contain a NUL character';
  const rest = to.startsWith('~/') ? to.slice(2) : to.slice(path.parse(to).root.length);
  // Backslash is a separator on win32; splitting on it everywhere only refuses more.
  const segments = rest.split(/[\\/]/);
  if (segments.includes('..')) return `must not contain a .. segment (got ${show(to)})`;
  if (!segments.some((s) => s !== '' && s !== '.')) return `must name a path below / or ~ (got ${show(to)})`;
  return null;
}

/** Every command name a step may run: non-null strings in top-level `commands` or any component's `commands`. */
function commandNames(c: any): Set<string> {
  const names = new Set<string>();
  const add = (m: unknown) => {
    if (isMap(m)) for (const [k, v] of Object.entries(m)) if (typeof v === 'string') names.add(k);
  };
  add(c?.commands);
  if (Array.isArray(c?.components)) for (const comp of c.components) if (isMap(comp)) add(comp.commands);
  return names;
}

/** Every problem with `checkout`, in the form validateConfig reports. */
export function checkoutProblems(c: any): string[] {
  const list = c?.checkout;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`checkout must be a list (got ${show(list)})`];
  const problems: string[] = [];
  const commands = commandNames(c);
  const seen = new Map<string, number>();
  list.forEach((e: unknown, i: number) => {
    const at = `checkout[${i}]`;
    if (!isMap(e)) return problems.push(`${at} must be a map with link and to, or run`);
    const hasLink = e.link !== undefined;
    const hasRun = e.run !== undefined;
    if (hasLink === hasRun) return problems.push(`${at} needs exactly one of link or run`);
    if (hasLink) {
      if (!isInsidePath(e.link) || e.link.includes('\0')) problems.push(`${at}.link must be a relative path inside the job's worktree, with no .. segment (got ${show(e.link)})`);
      if (e.undo !== undefined) problems.push(`${at}.undo is only for a run step`);
      const tp = targetProblem(e.to);
      if (tp) return problems.push(`${at}.to ${tp}`);
      // Compared resolved, so `~/p`, `<home>/p` and `<home>\p` are one target; win32 paths ignore case.
      const resolved = resolveTarget(e.to);
      const target = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      const first = seen.get(target);
      if (first !== undefined) problems.push(`${at}.to repeats checkout[${first}].to`);
      else seen.set(target, i);
      return;
    }
    if (e.to !== undefined) problems.push(`${at}.to is only for a link step`);
    for (const key of ['run', 'undo'] as const) {
      const v = e[key];
      if (key === 'undo' && (v === undefined || v === null)) continue;
      if (typeof v !== 'string' || !v.trim()) problems.push(`${at}.${key} must name a configured command (got ${show(v)})`);
      else if (!commands.has(v)) problems.push(`${at}.${key} names no configured command ${show(v)}`);
    }
  });
  return problems;
}
