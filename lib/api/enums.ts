// The unions the /api shapes share, each derived from its runtime list in constants.ts; the only type module that imports constants.ts.
import type { ACTOR_SOURCES, BUDGET_KEYS, COMPLEXITIES, COMPONENT_KINDS, DEPENDENCY_TYPES, EFFORTS, HANDOFF_CLASSES, INTERIM_STRATEGIES, OFFICE_GATES, REPO_BUDGET_KEYS, REPO_BUDGET_MODES, REQUEST_TYPES, SHELF_ACTIONS, STAGES, STATES, WAITING_ON } from './constants.ts';

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
/** Where an event's actor came from: ACTOR_SOURCES in lib/core/job/schema.ts. */
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/** Request types the inbox accepts: REQUEST_TYPES in lib/core/job/requests.ts. */
export type RequestType = (typeof REQUEST_TYPES)[number];

/** A Shelved list batch action: SHELF_ACTIONS in lib/api/constants.ts. */
export type ShelfAction = (typeof SHELF_ACTIONS)[number];
