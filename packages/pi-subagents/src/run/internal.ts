import type * as Deferred from "effect/Deferred";
import type * as Scope from "effect/Scope";
import type { ChildLaunchRequest, ChildProcessHandle } from "../boundary/child-process.ts";
import type { SubagentError } from "./errors.ts";
import type { SubagentRunView } from "./model.ts";
import type { RpcResponse } from "./protocol.ts";
import type { RateLimitNoticeState } from "./rate-limit.ts";

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
  pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  latestAssistantText?: string | undefined;
  pauseRequested: boolean;
  stoppedByParent: boolean;
  cleanupPending: boolean;
  replyPendingRequestId?: string | undefined;
  warningTurnTriggered: boolean;
  completionGeneration: number;
  completionConsumedGeneration: number;
  completionNotifiedGeneration: number;
  completionClaims: number;
  rateLimitGeneration: number;
  rateLimitRejected: boolean;
  rateLimitRejectionNotified: boolean;
  rateLimitWarning?: string | undefined;
  readonly rateLimitNotices: Map<string, RateLimitNoticeState>;
}
