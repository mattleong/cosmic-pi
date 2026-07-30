import type * as Deferred from "effect/Deferred";
import type * as Scope from "effect/Scope";
import type { ChildLaunchRequest, ChildProcessHandle } from "../boundary/child-process.ts";
import type { SubagentError } from "./errors.ts";
import { isTerminalRunState, type SubagentRunView } from "./model.ts";
import type { RpcResponse } from "./protocol.ts";

export interface PendingInitializationSettlement {
  readonly state: "completed" | "failed" | "stopped";
  readonly error?: string | undefined;
}

/** Stopped-by-parent, stopping, or terminal records ignore further child events. */
export const isInactiveRunRecord = (record: RunRecord): boolean =>
  record.stoppedByParent ||
  record.view.state === "stopping" ||
  isTerminalRunState(record.view.state);

export interface RunRecord {
  view: SubagentRunView;
  scope: Scope.Closeable;
  launch: ChildLaunchRequest;
  process?: ChildProcessHandle | undefined;
  readonly responses: Map<string, Deferred.Deferred<RpcResponse, SubagentError>>;
  readonly activeTools: Map<string, string>;
  nextRpcId: number;
  settlement: Deferred.Deferred<SubagentRunView>;
  readonly foregroundOutcome: Deferred.Deferred<SubagentRunView>;
  foregroundWaitPending: boolean;
  foregroundCompletionClaimGeneration?: number | undefined;
  pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  latestAssistantText?: string | undefined;
  pauseRequested: boolean;
  stoppedByParent: boolean;
  cleanupPending: boolean;
  initializationPending: boolean;
  pendingInitializationSettlement?: PendingInitializationSettlement | undefined;
  replyPendingRequestId?: string | undefined;
  warningTurnTriggered: boolean;
  notificationGeneration: number;
  questionNotificationGeneration: number;
  readonly warningNotificationGenerations: Map<string, number>;
  completionGeneration: number;
  completionConsumedGeneration: number;
  completionNotifiedGeneration: number;
  completionClaims: number;
}
