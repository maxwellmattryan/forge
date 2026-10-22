// The globs specs and the protected-paths policy name, matched against repo-relative paths. A leaf,
// so scope, protected, policy-check and the panel share it without importing each other.
import path from 'node:path';

/** `**` crosses directories, `*` and `?` do not; anchored to the whole string. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('**/')
    .map((part) =>
      part
        .split('**')
        .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

/** Whether a changed file is covered by any token named in the spec. */
export function inSpec(file: string, tokens: string[]): boolean {
  const base = path.posix.basename(file);
  return tokens.some((t) => {
    if (file === t) return true;
    if (t.endsWith('/') ? file.startsWith(t) : file.startsWith(`${t}/`)) return true;
    if (t.includes('*') || t.includes('?')) {
      const re = globToRegExp(t.replace(/\/$/, ''));
      // A slash-free glob (`*.test.mjs`) is read like a bare filename and matched against the basename too.
      return re.test(file) || (!t.includes('/') && re.test(base));
    }
    return !t.includes('/') && base === t;
  });
}
