// commandEnv: validation of what configured commands inherit beyond the allowlist and whether they
// run under the login shell (docs/CONFIG.md "Command environment"). Self-contained in core, so
// lib/core/config/validate.ts imports it without the guard code that applies it.
import { isMap, show } from '../../shape.ts';

/** A variable name, or a glob of one: letters, digits, `_`, `(`, `)` (`ProgramFiles(x86)`) and `*`. */
const INHERIT_ENTRY = /^[A-Za-z0-9_*()]+$/;

/** Why one commandEnv.inherit entry is refused, or null. */
export function inheritEntryProblem(entry: unknown): string | null {
  if (typeof entry !== 'string') return `commandEnv.inherit entries must be strings (got ${show(entry, 40)})`;
  if (!INHERIT_ENTRY.test(entry)) return `commandEnv.inherit entry ${show(entry, 60)} must be a variable name or a glob of one (letters, digits, _, ( ) and *)`;
  if (!/[^*]/.test(entry)) return `commandEnv.inherit entry ${show(entry, 60)} would pass the whole environment; name the variables (globs such as JAVA_* are fine)`;
  return null;
}

/** commandEnv.*: shape problems for forge config validate and forge doctor. */
export function commandEnvProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const ce = cfg.commandEnv;
  if (ce === undefined) return [];
  if (!isMap(ce)) return [`commandEnv must be a map with inherit and loginShell (got ${show(ce, 40)})`];
  const problems: string[] = [];
  if (ce.inherit !== undefined) {
    if (!Array.isArray(ce.inherit)) problems.push(`commandEnv.inherit must be a list of variable names (got ${show(ce.inherit, 40)})`);
    else
      for (const entry of ce.inherit) {
        const p = inheritEntryProblem(entry);
        if (p) problems.push(p);
      }
  }
  if (ce.loginShell !== undefined && typeof ce.loginShell !== 'boolean') problems.push(`commandEnv.loginShell must be true or false (got ${show(ce.loginShell, 40)})`);
  return problems;
}
