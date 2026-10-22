// Which lib layer each of today's flat lib/ files belongs to, and the upward imports still allowed.
// Data only, read by test/invariants/layers.test.ts; docs/design/lib-layout.md explains the placement.
// The move (#421) puts each file under lib/<layer>/, which empties FLAT_LAYERS and re-keys
// ALLOWED_EDGES to the new paths; every later job only deletes entries from either list.

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
  integrations: [
    'actor.ts', 'docker.ts', 'gh.ts', 'git.ts', 'github-preview.ts', 'pricing.ts', 'repo-slug.ts',
    'trackers/github.ts', 'trackers/local.ts', 'transcripts.ts',
  ],
  engine: [
    'step/', 'step.ts',
    'acs.ts', 'attribution.ts', 'audit.ts', 'autonomy.ts', 'backing-db.ts', 'backing.ts', 'brief.ts', 'budget.ts',
    'bundle.ts', 'checkout.ts', 'config-sinks-apply.ts', 'delete.ts', 'delta.ts', 'deps.ts', 'detect-components.ts',
    'detect.ts', 'doctor.ts', 'downstream.ts', 'e2e.ts', 'editor.ts', 'endpoints.ts', 'environment-lifecycle.ts',
    'environment-record.ts', 'environment.ts', 'eval-overlay.ts', 'eval-stats.ts', 'evals.ts', 'experiments.ts',
    'findings.ts', 'focus-actions.ts', 'integrity.ts', 'interim-apply.ts', 'interim.ts', 'job-command.ts',
    'job-repos.ts', 'known-secrets.ts', 'learnings.ts', 'links.ts', 'member-panel.ts', 'member-repos.ts',
    'member-trackers.ts', 'outcome.ts', 'panel.ts', 'ports.ts', 'pr.ts', 'project.ts', 'protected.ts',
    'provenance.ts', 'recall.ts', 'redact.ts', 'regenerate.ts', 'release-approval.ts', 'release-plan.ts',
    'release-run.ts', 'repo-budget.ts', 'repo-order.ts', 'repo-proposals.ts', 'request-refresh.ts', 'retention.ts',
    'retro.ts', 'roster.ts', 'scope.ts', 'scoring.ts', 'secret-refs.ts', 'secrets.ts', 'spend.ts', 'stats.ts',
    'title.ts', 'tracker-link.ts', 'trackers/index.ts', 'trackers/mirror.ts', 'triage.ts', 'update.ts', 'usage.ts',
    'verifiers.ts', 'version.ts', 'worktree.ts',
  ],
  office: ['daemon-owner.ts', 'daemon-pool.ts', 'daemon.ts', 'foreman.ts', 'notify.ts', 'reconcile.ts', 'session-agents.ts'],
  server: ['server.ts'],
  cli: ['activity.ts', 'cli.ts', 'commands/'],
};

/**
 * Today's upward imports, `<from> → <to>` with lib-relative paths, sorted. The list only shrinks; each
 * entry's comment names its kind and docs/design/lib-layout.md › Today's upward edges what removes it.
 */
export const ALLOWED_EDGES: string[] = [
  'api/tracker.ts → core/types.ts', // api type-imports core: the types split
  'core/config/validate.ts → member-repos.ts', // core reads engine: member repo validators
  'core/job/lens.ts → member-repos.ts', // core reads engine: member repo validators
  'core/job/schema.ts → delta.ts', // core reads engine: value validators the normalisers use
  'core/job/schema.ts → member-repos.ts', // core reads engine: value validators the normalisers use
  'core/job/store.ts → actor.ts', // core reaches integrations: the job store
  'core/job/store.ts → eval-overlay.ts', // core reads engine: the job store
  'core/job/store.ts → known-secrets.ts', // core reads engine: the job store
  'core/job/store.ts → pricing.ts', // core reaches integrations: the job store
  'core/job/store.ts → provenance.ts', // core reads engine: the job store
  'core/job/store.ts → repo-slug.ts', // core reaches integrations: the job store
  'core/paths.ts → git.ts', // core reaches integrations: the main checkout's root
  'core/types.ts → acs.ts', // core type-imports engine: the types split
  'core/types.ts → findings.ts', // core type-imports engine: the types split
  'core/types.ts → secrets.ts', // core type-imports engine: the types split
  'doctor.ts → daemon.ts', // engine reaches office: the session's API-key variables
  'doctor.ts → notify.ts', // engine reaches office: notify transport
  'pr.ts → foreman.ts', // engine reaches office: the Foreman's gate classes
  'pr.ts → notify.ts', // engine reaches office: notify transport
  'release-approval.ts → foreman.ts', // engine reaches office: the Foreman's gate classes
  'secrets.ts → notify.ts', // engine reaches office: notify transport
  'step/gates.ts → foreman.ts', // engine reaches office: the Foreman's round ceilings
  'step/stages/build.ts → foreman.ts', // engine reaches office: the Foreman's round ceilings
  'step/stages/decide.ts → foreman.ts', // engine reaches office: the Foreman's round ceilings
  'trackers/github.ts → attribution.ts', // integrations reach engine: tracker security wrappers
  'trackers/github.ts → pr.ts', // integrations reach engine: repoSlug
];
