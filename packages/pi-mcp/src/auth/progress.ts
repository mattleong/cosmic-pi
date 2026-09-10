import * as Effect from "effect/Effect";
import type { McpActivityPhase } from "../activity/model.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpLoginUi } from "./model.ts";

export type McpAuthPhase =
  | "waiting-fence"
  | "storage"
  | "callback-listener"
  | "discovery"
  | "registration"
  | "opening-browser"
  | "awaiting-callback"
  | "exchange"
  | "saving"
  | "finalizing"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";
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
export const authActivityPhase = (phase: McpAuthPhase): McpActivityPhase | undefined => {
  switch (phase) {
    case "waiting-fence":
      return "waiting-for-fence";
    case "storage":
      return "checking-storage";
    case "callback-listener":
      return "preparing-callback";
    case "discovery":
      return "discovering";
    case "registration":
      return "preparing-client";
    case "opening-browser":
      return "opening-browser";
    case "awaiting-callback":
      return "browser-approval";
    case "exchange":
      return "exchanging-code";
    case "saving":
      return "saving-credentials";
    case "finalizing":
      return "finalizing";
    case "cancelling":
      return "stopping";
    default:
      return undefined;
  }
};
export const authPhaseLabel = (phase: McpAuthPhase): string => {
  switch (phase) {
    case "waiting-fence":
      return "Waiting for authentication access and connection cleanup";
    case "storage":
      return "Checking secure storage";
    case "callback-listener":
      return "Preparing the callback listener";
    case "discovery":
      return "Discovering authentication metadata";
    case "registration":
      return "Preparing the public client";
    case "opening-browser":
      return "Opening the browser";
    case "awaiting-callback":
      return "Waiting for browser approval";
    case "exchange":
      return "Validating the response and exchanging the code";
    case "saving":
      return "Saving credentials";
    case "finalizing":
      return "Finalizing authentication access";
    case "cancelling":
      return "Cancelling and closing owned resources";
    case "cancelled":
      return "Sign-in cancelled";
    case "succeeded":
      return "Sign-in completed. Connect separately when ready.";
    case "failed":
      return "Sign-in did not complete";
  }
};
export const authProgress = (ui: McpLoginUi, event: McpAuthProgressEvent): Effect.Effect<void> =>
  ui.progress ? ui.progress(event) : Effect.void;

/** Only an active local browser wait offers reopen. Time never extends its authority. */
export const authCanReopen = (progress: McpAuthProgress, now: number): boolean =>
  progress.canReopen &&
  progress.mode === "local" &&
  (progress.phase === "awaiting-callback" || progress.phase === "opening-browser") &&
  progress.deadline !== undefined &&
  now < progress.deadline;
