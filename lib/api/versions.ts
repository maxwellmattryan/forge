// The /api version steps: `apiVersion` is this list's length plus one. An /api/* or SSE shape change
// appends one `{ id }` here and sets the dashboard's API_VERSION literal (its lib/types.ts) to match.
// Append only, like lib/core/versions/: each entry starts its own line as `  { id: '`, which the
// release notes count; on conflict keep both, in merge order. Imports nothing.

export const API_CHANGES = [
  // The changes from before this list existed, named by the version they introduced.
  { id: 'api-2' },
  { id: 'api-3' },
  { id: 'api-4' },
  { id: 'api-5' },
  { id: 'api-6' },
  { id: 'api-7' },
  { id: 'api-8' },
  { id: 'api-9' },
  { id: 'api-10' },
  { id: 'api-11' },
  { id: 'api-12' },
  { id: 'api-13' },
  { id: 'api-14' },
  { id: 'api-15' },
  { id: 'api-16' },
  { id: 'api-17' },
  { id: 'api-18' },
  { id: 'api-19' },
  { id: 'api-20' },
  { id: 'api-21' },
  { id: 'api-22' },
  { id: 'api-23' },
  { id: 'api-24' },
  { id: 'api-25' },
  { id: 'api-26' },
  { id: 'api-27' },
  { id: 'api-28' },
  { id: 'api-29' },
  { id: 'api-30' },
  { id: 'api-31' },
  { id: 'api-32' },
  { id: 'api-33' },
  { id: 'api-34' },
  { id: 'api-35' },
  { id: 'api-36' },
  { id: 'api-37' },
  { id: 'triage-hidden-text' },
  { id: 'job-merge-now' },
  { id: 'actor-source-daemon' },
  { id: 'daemon-budget' },
  // Stats.cost.sessions (supervisor-metered spend by session kind) and JobEvent.metered|unmeasured on agent-end.
  { id: 'session-meter' },
  // One server per machine: project routes under /api/p/<project>/, GET /api/projects and its stream, DaemonPoolState.machine and .needsApproval.
  { id: 'machine-server' },
  // The Overview: MachineProjectSummary.latest and .daemon.office, GET /api/projects/stats.
  { id: 'overview' },
  // Job.mandate: the mandate a job works under, or null.
  { id: 'job-mandate' },
  // RequestType 'draft': a goal mandate's drafting run, written only by forge mandate, routed to the office session.
  { id: 'draft-request' },
  // DaemonPoolState.assistants; Stats.cost.sessions.assistant; gate requests route to the assistant sessions' request group.
  { id: 'assistant-foremen' },
  // Stats.quality.verifierFirstRoundBlockRate: the share of jobs whose first round-1 verifiers record blocked.
  { id: 'verifier-first-round-block-rate' },
  // ApiState.drafts (DraftGate), GET and POST /api/mandates/:id/draft; a job-less milestone-approval gate request.
  { id: 'milestone-approval' },
  // POST /api/projects: register a project from the dashboard's Add project dialog.
  { id: 'add-project' },
  // RequestType 'direct': the Office pass's wake for the office session; NotifyEvent mandate-stalled, mandate-budget and mandate-closed.
  { id: 'director-loop' },
  // The chat routes under /api/p/<project>/chats (Chat, ChatLogEntry, ChatLogPage, ChatDetail, ChatList); scope `_chat-<id>`
  // in /events, /daemons/log, /daemon/permission, /daemon/mode and /daemon; ActorSource 'chat'; Stats.cost.sessions.chat.
  { id: 'chats' },
  // DaemonPoolState.gates (GateRunsState, GateRunState): forge dash's gate runner and its runs; gate requests route to
  // `_gates`, which no session serves; DaemonPoolState.assistants is always {} (dropped with the dashboard's last reader).
  { id: 'gate-runs' },
] as const;

/**
 * The /api/state and other /api/* shape version the dashboard reads; it is served by the same plugin
 * version. Typed as the literal length + 1, so the dashboard's copy is pinned to it with `satisfies`.
 */
export const API_VERSION = (API_CHANGES.length + 1) as [...typeof API_CHANGES, unknown]['length'];
