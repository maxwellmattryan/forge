// Which lib layer each lib/ file outside a lib/<layer>/ folder belongs to, and the upward imports still
// allowed. Data only, read by test/invariants/layers.test.ts; docs/design/lib-layout.md explains the
// placement. The move (#421) put every other file under lib/<layer>/, leaving only the deprecated tracker
// re-exports flat, and re-keyed ALLOWED_EDGES to the new paths; every later job only deletes entries from
// either list.

/** The lib layers, lowest first: a file may import its own layer and the ones before it. */
export const LAYERS = ['api', 'core', 'integrations', 'engine', 'office', 'server', 'cli'] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Lib-relative posix paths of files outside a lib/<layer>/ folder. A key ending in `/` covers the
 * whole folder; an exact file key wins over a folder key.
 */
export const FLAT_LAYERS: Record<Layer, string[]> = {
  api: ['trackers/status.mjs', 'trackers/status.ts'],
  core: [],
  integrations: [],
  engine: [],
  office: [],
  server: [],
  cli: [],
};

/**
 * Today's upward imports, `<from> → <to>` with lib-relative paths, sorted. The list only shrinks; each
 * entry's comment names its kind and docs/design/lib-layout.md › Today's upward edges what removes it.
 */
export const ALLOWED_EDGES: string[] = [
  'api/tracker.ts → core/types.ts', // api type-imports core: the types split
  'core/config/validate.ts → engine/project/member-repos.ts', // core reads engine: member repo validators
  'core/job/lens.ts → engine/project/member-repos.ts', // core reads engine: member repo validators
  'core/job/schema.ts → engine/pr/delta.ts', // core reads engine: value validators the normalisers use
  'core/job/schema.ts → engine/project/member-repos.ts', // core reads engine: value validators the normalisers use
  'core/job/store.ts → engine/evals/overlay.ts', // core reads engine: the job store
  'core/job/store.ts → engine/evals/provenance.ts', // core reads engine: the job store
  'core/job/store.ts → engine/guard/known-secrets.ts', // core reads engine: the job store
  'core/job/store.ts → integrations/claude/pricing.ts', // core reaches integrations: the job store
  'core/job/store.ts → integrations/git/repo-slug.ts', // core reaches integrations: the job store
  'core/job/store.ts → integrations/github/actor.ts', // core reaches integrations: the job store
  'core/paths.ts → integrations/git/runner.ts', // core reaches integrations: the main checkout's root
  'core/types.ts → engine/guard/secrets.ts', // core type-imports engine: the types split
  'core/types.ts → engine/pipeline/acs.ts', // core type-imports engine: the types split
  'core/types.ts → engine/pipeline/findings.ts', // core type-imports engine: the types split
  'engine/guard/secrets.ts → office/notify.ts', // engine reaches office: notify transport
  'engine/ops/doctor.ts → office/notify.ts', // engine reaches office: notify transport
  'engine/ops/doctor.ts → office/session/lifecycle.ts', // engine reaches office: the session's API-key variables
  'engine/pipeline/step/gates.ts → office/foreman.ts', // engine reaches office: the Foreman's round ceilings
  'engine/pipeline/step/stages/build.ts → office/foreman.ts', // engine reaches office: the Foreman's round ceilings
  'engine/pipeline/step/stages/decide.ts → office/foreman.ts', // engine reaches office: the Foreman's round ceilings
  'engine/pr/lifecycle.ts → office/foreman.ts', // engine reaches office: the Foreman's gate classes
  'engine/pr/lifecycle.ts → office/notify.ts', // engine reaches office: notify transport
  'engine/release/approval.ts → office/foreman.ts', // engine reaches office: the Foreman's gate classes
  'integrations/github/tracker.ts → engine/guard/attribution.ts', // integrations reach engine: tracker security wrappers
  'integrations/github/tracker.ts → engine/pr/lifecycle.ts', // integrations reach engine: repoSlug
];
