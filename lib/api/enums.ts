// The unions the /api shapes share, each derived from its runtime list in constants.ts; the only type module that imports constants.ts.
import type {
  ACTOR_SOURCES,
  BUDGET_KEYS,
  COMPLEXITIES,
  COMPONENT_KINDS,
  DEPENDENCY_TYPES,
  DIRECTIVE_ACTIONS,
  EFFORTS,
  ESCALATION_RULES,
  GATE_RUN_OUTCOMES,
  HANDOFF_CLASSES,
  INTERIM_STRATEGIES,
  MANDATE_ON_UNFINISHABLE,
  MANDATE_ORDERS,
  MANDATE_SCORING,
  MANDATE_STATUSES,
  MANDATE_UNTIL,
  OFFICE_GATES,
  OFFICE_RUN_OUTCOMES,
  OVERLAP_GAPS,
  OVERLAP_KINDS,
  OVERLAP_REASONS,
  OVERLAP_SOURCES,
  OVERLAP_TIMINGS,
  REPO_BUDGET_KEYS,
  REPO_BUDGET_MODES,
  REQUEST_TYPES,
  SHELF_ACTIONS,
  STAGES,
  STATES,
  WAITING_ON,
} from './constants.ts';

/** A pipeline stage: STAGES in lib/core/job/schema.ts. */
export type Stage = (typeof STAGES)[number];
/** A job state: STATES in lib/core/job/schema.ts. */
export type JobState = (typeof STATES)[number];
/** Why a job waits: WAITING_ON in lib/core/job/schema.ts. */
export type WaitingOn = (typeof WAITING_ON)[number];
/** lib/core/job/schema.ts BUDGET_KEYS. */
export type BudgetKey = (typeof BUDGET_KEYS)[number];
/** A repo budget cap: REPO_BUDGET_KEYS in lib/core/job/schema.ts. */
export type RepoBudgetKey = (typeof REPO_BUDGET_KEYS)[number];
/** budget.onExceeded: REPO_BUDGET_MODES in lib/core/job/schema.ts. */
export type RepoBudgetMode = (typeof REPO_BUDGET_MODES)[number];
/** A reasoning effort level: EFFORTS in lib/core/job/schema.ts. */
export type Effort = (typeof EFFORTS)[number];
/** Where a resolved effort came from: resolveEffort in lib/core/config/load.ts. */
export type EffortSource = 'job' | 'panel' | 'role' | 'complexity' | 'config' | 'none';
/** A spec's judged difficulty: COMPLEXITIES in lib/core/job/schema.ts. */
export type Complexity = (typeof COMPLEXITIES)[number];

export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type InterimStrategy = (typeof INTERIM_STRATEGIES)[number];

/** A gate class the foreman may decide: OFFICE_GATES in lib/core/job/schema.ts. */
export type GateClass = (typeof OFFICE_GATES)[number];
/** Why the Foreman left a gate for a person: HANDOFF_CLASSES in lib/core/job/schema.ts. */
export type HandoffClass = (typeof HANDOFF_CLASSES)[number];
/** Why a job needs a person before merge: ESCALATION_RULES in lib/api/constants.ts. */
export type GateRule = (typeof ESCALATION_RULES)[number];
/** How a gate run ended: GATE_RUN_OUTCOMES in lib/api/constants.ts. */
export type GateRunOutcome = (typeof GATE_RUN_OUTCOMES)[number];
/** How an office run ended: OFFICE_RUN_OUTCOMES in lib/api/constants.ts. */
export type OfficeRunOutcome = (typeof OFFICE_RUN_OUTCOMES)[number];
/** Where an event's actor came from: ACTOR_SOURCES in lib/core/job/schema.ts. */
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/** Request types the inbox accepts: REQUEST_TYPES in lib/core/job/requests.ts. */
export type RequestType = (typeof REQUEST_TYPES)[number];

/** A mandate's written status: only `forge mandate pause|resume|close`, the Office page and the Office pass move it. */
export type MandateStatus = (typeof MANDATE_STATUSES)[number];
/** A mandate's until: MANDATE_UNTIL. */
export type MandateUntil = (typeof MANDATE_UNTIL)[number];
/** A mandate's order: MANDATE_ORDERS. */
export type MandateOrder = (typeof MANDATE_ORDERS)[number];
/** A mandate's onUnfinishable: MANDATE_ON_UNFINISHABLE. */
export type MandateOnUnfinishable = (typeof MANDATE_ON_UNFINISHABLE)[number];
/** A mandate's scoring: MANDATE_SCORING. */
export type MandateScoring = (typeof MANDATE_SCORING)[number];
/** A directive's action: DIRECTIVE_ACTIONS. */
export type DirectiveAction = (typeof DIRECTIVE_ACTIONS)[number];
/** A Shelved list batch action: SHELF_ACTIONS in lib/api/constants.ts. */
export type ShelfAction = (typeof SHELF_ACTIONS)[number];

/** An overlap counterpart's kind: OVERLAP_KINDS in lib/api/constants.ts. */
export type OverlapKind = (typeof OVERLAP_KINDS)[number];
/** Where an overlap side's files came from: OVERLAP_SOURCES. */
export type OverlapSource = (typeof OVERLAP_SOURCES)[number];
/** The overlap check's timing: OVERLAP_TIMINGS. */
export type OverlapTiming = (typeof OVERLAP_TIMINGS)[number];
/** A reason code in an overlap report: OVERLAP_REASONS. */
export type OverlapReason = (typeof OVERLAP_REASONS)[number];
/** What the overlap check could not read: OVERLAP_GAPS. */
export type OverlapGap = (typeof OVERLAP_GAPS)[number];
