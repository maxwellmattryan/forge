// Types for build-stamp.mjs, which scripts/release-check.ts imports from strict TypeScript.
export const STAMP: string;
export function sourceHash(dashboardDir: string, lockPath: string): string;
export function distHash(distDir: string): string;
