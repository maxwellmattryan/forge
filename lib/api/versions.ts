// The /api version steps: `apiVersion` is this list's length plus one. An /api/* or SSE shape change
// appends one `{ id }` here and sets the dashboard's API_VERSION literal (its src/lib/core/types.ts) to match.
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
  // The Foreman page's mandate routes: GET /api/mandates (MandatesResponse), GET /api/mandates/:id (MandateDetailResponse),
  // POST /api/mandates and /api/mandates/:id/edit|pause|resume|close (PostMandateResponse); MandateRow, Directive.
  { id: 'foreman-page' },
  // AgentRow.runs: every ended run of the role with its billing split and context composition; AgentRow.tokens is now
  // the sum of those runs' totals. JobAgent.runHistory and .legacyRuns are kept out of /api/state and JobDetail.job.
  { id: 'agent-runs' },
  // MandateContract.scoring (all | sample | off); the scoring term on POST /api/mandates and /api/mandates/:id/edit.
  { id: 'mandate-scoring' },
  // MandateRow.card (MandateReportCard, CardFigure): the live report card on GET /api/mandates and /api/mandates/:id.
  { id: 'mandate-report-card' },
  // PostMandateBody.id is optional: POST /api/mandates without one gets a generated id (m-<8 hex>), returned as mandate.id.
  { id: 'mandate-auto-id' },
  // Shelve: WaitingOn 'shelved', Job.shelved, Job.finishedWhileShelved, Stats.counts.shelved and POST /api/shelf.
  { id: 'shelve' },
  // MandateUntil 'released'; DirectiveAction 'release'; a job-less `release` gate request naming a mandate.
  { id: 'mandate-until-released' },
  // DaemonPoolState.gates (GateRunsState, GateRunState): forge dash's gate runner and its runs; gate requests route to
  // `_gates`, which no session serves; DaemonPoolState.assistants is gone.
  { id: 'gate-runs' },
  // MandateContract.quality ({pauseBelow, minScored}); the pauseBelow and minScored terms on POST /api/mandates and /api/mandates/:id/edit.
  { id: 'mandate-quality' },
  // DaemonSessionState.contextTokens: the running child's last turn context.
  { id: 'session-context' },
  // GET /api/backlog/item?ref= (BacklogItemResponse, TrackerItemView, TrackerComment): one tracker item's text and facts for the issue panel.
  { id: 'backlog-item' },
  // Job.services is gone: Job.components (the list Forge acts on), Job.componentsDeclared (the spec's estimate) and
  // Job.componentsFromDiff (forge verify's recompute from the committed diff) and Job.componentsUnmatched (that recompute
  // found changed root files no component covers, so the top-level commands run).
  { id: 'job-components' },
  // GateRunOutcome 'shelved' (a senior pass shelved the job, under foreman.escalations: foreman); GateRunState.attempts
  // goes up to 4, the first assistant's turns plus the senior's.
  { id: 'senior-pass' },
  // DirectiveAction 'retro': a mandate's close queued its retro request.
  { id: 'directive-retro' },
  // MandateRow.closing (MandateClosingCard): a closed mandate's closing summary card on GET /api/mandates and /api/mandates/:id.
  { id: 'mandate-closing-card' },
  // DaemonPoolState.launchPermissionMode, ProjectsResponse.machine.launchPermissionMode, ActorSource 'launch'.
  { id: 'launch-permission-mode' },
  // Stats review and timing figures: ReviewerStats.soleChanges and .reopened, quality.findingsCarried and .findingsNew,
  // speed.stageMinutes, .waitingMinutes, .medianHandoffMinutes, .stalledMinutes, .handoffSeconds, .agentStartSeconds,
  // .minutesPerExtraRound and .timedJobs (TimeSpread), and UsageRow.cacheReadShare on cost.byRole rows.
  { id: 'stats-review-timing' },
  // POST /api/session (PostSessionBody, PostSessionResponse): the login exchange; every other /api route needs the
  // forge-<port> cookie or x-forge-token, 401 otherwise, and ?token= is gone.
  { id: 'session-login' },
  // JobPr.failingChecks (PrFailingChecks) and .feedbackSinceRound; POST /api/jobs/:id/ci (PostJobCiBody, PostJobCiResponse).
  { id: 'pr-review-actions' },
  // DaemonSessionState.timedOut (DaemonTimedOutPrompt): the session's last 10 prompts denied because nobody answered
  // them within daemon.permissionTimeoutMinutes, newest first.
  { id: 'permission-timeout' },
  // Job.contexts (ContextSession): the context sessions `forge job agent run` started; ContextMark as `context` on a
  // role run's agent-end event, and the `context-session` event with its usage under role `context`.
  { id: 'context-sessions' },
  // Stats.cost.orchestrator (OrchestratorSpend, LaneSpend); Stats.cost.sessions' job key is job-session (was orchestrator);
  // StateJob.lastEvent and JobDetail.events leave out session-usage events.
  { id: 'orchestrator-spend' },
  // PipelineConfig.resumeRework; `resume` and `resumeSkipped` on the agent-start event and `resumeFailed` on a role
  // run's agent-end.
  { id: 'resume-rework' },
  // StateJob.gateReasons (GateReason[] | null): the rules an escalation park lists, each with its CLI-composed detail.
  { id: 'gate-reasons' },
  // UsageRow.peakContext and UsageRow.runTokens (TimeSpread) on Stats.cost.byRole rows: the role's recorded runs'
  // composition.total and usage.totalTokens.
  { id: 'role-peak-context' },
  // DaemonPoolState.office is OfficeRunsState (OfficeRunState, OfficeRunOutcome): forge dash's office runner runs draft
  // and direct requests in code, and the office session is retired; MachineProjectSummary.daemon.office is derived from it.
  { id: 'office-runs' },
] as const;

/**
 * The /api/state and other /api/* shape version the dashboard reads; it is served by the same plugin
 * version. Typed as the literal length + 1, so the dashboard's copy is pinned to it with `satisfies`.
 */
export const API_VERSION = (API_CHANGES.length + 1) as [...typeof API_CHANGES, unknown]['length'];
