// The dashboard's built CSS, as the CSS and token tests read it.
import fs from 'node:fs';
import path from 'node:path';
import { DIST } from './dist.ts';

/**
 * Every stylesheet the manifest names, joined. Spacing a minifier may or may not keep (`) 0`, `) var(`,
 * ` * `, `, `, `@media (`) is dropped, so a toolchain bump that only changes spacing does not fail the
 * literal comparisons; a space after `)` before a selector character (`:is(a) .b`) is a combinator and stays.
 */
export function builtCss(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const files = new Set<string>();
  for (const e of Object.values<any>(manifest)) for (const f of [e.file, ...(e.css ?? [])]) if (String(f).endsWith('.css')) files.add(f);
  return [...files]
    .map((f) => fs.readFileSync(path.join(DIST, f), 'utf8'))
    .join('\n')
    .replace(/\)\s+(?=[\d-]|var\()/g, ')')
    .replace(/\s+\*\s+/g, '*')
    .replace(/,\s+/g, ',')
    .replace(/@media\s+\(/g, '@media(');
}
