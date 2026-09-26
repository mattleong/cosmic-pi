import * as Effect from "effect/Effect";
import type { McpActivityPhase } from "../activity/model.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpLoginUi } from "./model.ts";

const AUTH_PHASE_LABELS = {
  "waiting-fence": "Waiting for authentication access and connection cleanup",
  storage: "Checking secure storage",
  "callback-listener": "Preparing the callback listener",
  discovery: "Discovering authentication metadata",
  registration: "Preparing the public client",
  "scope-approval": "Waiting for permission approval",
  "opening-browser": "Opening the browser",
  "awaiting-callback": "Waiting for browser approval",
  exchange: "Validating the response and exchanging the code",
  saving: "Saving credentials",
  finalizing: "Finalizing authentication access",
  cancelling: "Cancelling and closing owned resources",
  cancelled: "Sign-in cancelled",
  succeeded: "Sign-in completed. Connect separately when ready.",
  failed: "Sign-in did not complete",
} as const;
export type McpAuthPhase = keyof typeof AUTH_PHASE_LABELS;
export type McpCredentialMutation = "idle" | "pending" | "blocked";

/** SDK and storage observers carry bounded facts, never auth values or errors. */
export interface McpAuthProgressEvent {
  readonly phase: McpAuthPhase;
  /** Absolute Clock deadline of the current owner. Omitted means no enforced deadline. */
  readonly deadline?: number;
  readonly mutation?: McpCredentialMutation;
  readonly credentialsSaved?: boolean;
  readonly reason?: McpBoundaryError["reason"];
}
export interface McpAuthProgress {
  readonly attemptId: number;
  readonly server: string;
  readonly mode: "local" | "manual";
  readonly phase: McpAuthPhase;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly deadline?: number;
  readonly canReopen: boolean;
  readonly credentialsSaved: boolean;
  readonly mutation: McpCredentialMutation;
  readonly reason?: McpBoundaryError["reason"];
  readonly failureKind?: McpBoundaryError["kind"];
}
export const authPhaseTerminal = (phase: McpAuthPhase): boolean =>
  phase === "cancelled" || phase === "succeeded" || phase === "failed";
const AUTH_ACTIVITY_PHASES = {
  "waiting-fence": "waiting-for-fence",
  storage: "checking-storage",
  "callback-listener": "preparing-callback",
  discovery: "discovering",
  registration: "preparing-client",
  "scope-approval": "browser-approval",
  "opening-browser": "opening-browser",
  "awaiting-callback": "browser-approval",
  exchange: "exchanging-code",
  saving: "saving-credentials",
  finalizing: "finalizing",
  cancelling: "stopping",
  cancelled: undefined,
  succeeded: undefined,
  failed: undefined,
} satisfies Record<McpAuthPhase, McpActivityPhase | undefined>;
export const authActivityPhase = (phase: McpAuthPhase): McpActivityPhase | undefined =>
  AUTH_ACTIVITY_PHASES[phase];
export const authPhaseLabel = (phase: McpAuthPhase): string => AUTH_PHASE_LABELS[phase];
export const authProgress = (ui: McpLoginUi, event: McpAuthProgressEvent): Effect.Effect<void> =>
  ui.progress ? ui.progress(event) : Effect.void;

/** Only an active local browser wait offers reopen. Time never extends its authority. */
export const authCanReopen = (progress: McpAuthProgress, now: number): boolean =>
  progress.canReopen &&
  progress.mode === "local" &&
  (progress.phase === "awaiting-callback" || progress.phase === "opening-browser") &&
  progress.deadline !== undefined &&
  now < progress.deadline;
