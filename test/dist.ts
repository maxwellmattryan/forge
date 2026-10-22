// Tests that read the real Vite build skip without one: develop never commits dashboard/dist/.
// CI's verify job sets FORGE_REQUIRE_DIST=1, so there they fail.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_DASHBOARD } from '../lib/core/paths.ts';

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dist');
/** A small hand-written dist for the server's serving tests (startServer's distDir seam). */
export const FIXTURE_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dist');
export const NOT_BUILT_SKIP = `dashboard/dist is not built: run ${BUILD_DASHBOARD}`;

/** The skip reason for a test that needs the real build, or false when it must run. */
export function noDist(): string | false {
  if (process.env.FORGE_REQUIRE_DIST === '1') return false;
  return fs.existsSync(path.join(DIST, 'manifest.json')) ? false : NOT_BUILT_SKIP;
}
