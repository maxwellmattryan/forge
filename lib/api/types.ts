// The /api/* and SSE shapes `forge dash` serves, type-only: a barrel over the owner modules mapped in
// lib/api/AGENTS.md. The dashboard imports this file with `import type` (through its own lib/core/types.ts)
// and type-checks it without Node's types, so it and the modules it re-exports never import Node or another
// engine module. lib/core/types.ts re-exports it for engine code.
export type * from './enums.ts';
export type * from './job.ts';
export type * from './state.ts';
export type * from './jobs.ts';
export type * from './daemon.ts';
export type * from './config.ts';
export type * from './stats.ts';
export type * from './repo.ts';
