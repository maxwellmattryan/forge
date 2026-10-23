// The docker runner's shapes, type-only: what one `docker` call returns and the runner tests replace.

/** One `docker` call's outcome: lib/engine/environment/backing.ts and lib/engine/environment/backing-db.ts. */
export interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  /** The docker binary is not on PATH. */
  missing?: boolean;
}

/** Runs `docker <args>`, with `input` on stdin (psql's SQL); tests inject an in-memory fake. */
export type DockerRunner = (args: string[], opts?: { timeoutMs?: number; input?: string }) => DockerResult;
