import type * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { SubagentError, SubagentProcessError } from "../run/errors.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type {
  RuntimeApiKey,
  SubagentCapability,
  SubagentUsage,
  SubagentCleanupDiagnostic,
} from "../run/model.ts";
import type {
  AgentCaller,
  AgentListResult,
  AgentReadResult,
  AgentSendResult,
} from "../run/agent-messaging.ts";
import type { OriginalTextSize } from "../run/state.ts";

export type BackendResumeToken = object;

export interface BackendLaunchRequest {
  readonly runId: string;
  readonly name: string;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string | undefined;
  readonly parentLeafId?: string | undefined;
  readonly resumeToken?: BackendResumeToken | undefined;
  readonly systemPrompt: string;
}

/** `agent_*` operations the root has already bound to the launched run as their caller. */
export interface BackendAgentMessaging {
  /** The bound caller and its cwd, which decide what its status cards show. */
  readonly caller: AgentCaller;
  readonly cwd: string;
  readonly list: (ids?: ReadonlyArray<string>) => Effect.Effect<AgentListResult, SubagentError>;
  readonly send: (to: string, message: string) => Effect.Effect<AgentSendResult, SubagentError>;
  readonly read: (ids: ReadonlyArray<string>) => Effect.Effect<AgentReadResult, SubagentError>;
}

export interface BackendStartupState {
  readonly model?: string | undefined;
  readonly effort: SubagentEffort;
  readonly sessionId: string;
  readonly sessionFile?: string | undefined;
  readonly resumeToken?: BackendResumeToken | undefined;
}

export interface BackendProxyRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly argumentsJson: string;
}

export interface BackendProxyResult {
  readonly content: ReadonlyArray<unknown>;
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface BackendAssistantTerminal {
  readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
  /** Sanitized and bounded by `boundOutputText`. */
  readonly text?: string | undefined;
  /** The text's size before the archive cap cut it. */
  readonly originalSize?: OriginalTextSize | undefined;
  readonly errorMessage?: string | undefined;
}

export type BackendEvent =
  | { readonly type: "run_started"; readonly assignmentEpoch: number }
  | {
      readonly type: "run_settled";
      readonly assignmentEpoch: number;
      readonly terminal?: BackendAssistantTerminal | undefined;
    }
  | { readonly type: "activity"; readonly assignmentEpoch: number }
  | { readonly type: "usage"; readonly usage: SubagentUsage }
  | {
      readonly type: "assistant_message";
      readonly assignmentEpoch: number;
      /** Sanitized and bounded by `boundOutputText`. */
      readonly text?: string | undefined;
      /** The text's size before the archive cap cut it. */
      readonly originalSize?: OriginalTextSize | undefined;
      /** The model that produced the reply, when the child reports one per message. */
      readonly model?: string | undefined;
      readonly usage: SubagentUsage;
      readonly terminal?: BackendAssistantTerminal | undefined;
    }
  | {
      readonly type: "tool_started";
      readonly assignmentEpoch: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_finished";
      readonly assignmentEpoch: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      readonly outputPreview?: string | undefined;
    }
  | {
      readonly type: "supervisor_contact";
      readonly assignmentEpoch: number;
      readonly requestId: string;
      readonly kind: "progress" | "question" | "warning";
      readonly message: string;
    }
  | {
      readonly type: "parent_question_cancelled";
      readonly assignmentEpoch: number;
      readonly requestId: string;
    }
  | {
      readonly type: "warning";
      readonly message: string;
    }
  | ({
      readonly type: "proxy_request";
      readonly respond: (
        ok: boolean,
        payloadJson: string,
      ) => Effect.Effect<void, SubagentProcessError>;
    } & BackendProxyRequest)
  | { readonly type: "proxy_cancel"; readonly requestId: string }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly diagnostic: string;
      readonly failure?: SubagentProcessError | undefined;
    };

type BackendExit = Extract<BackendEvent, { readonly type: "exit" }>;

export const toBackendExit = (exit: {
  readonly exitCode: number | null;
  readonly stderr: string;
}): BackendExit => ({ type: "exit", exitCode: exit.exitCode, diagnostic: exit.stderr });

interface BackendControls {
  readonly initialize: Effect.Effect<BackendStartupState, SubagentError>;
  readonly start: (message: string, assignmentEpoch: number) => Effect.Effect<void, SubagentError>;
  readonly steer: (message: string) => Effect.Effect<void, SubagentError>;
  readonly interrupt: Effect.Effect<void, SubagentError>;
  readonly reply: (requestId: string, message: string) => Effect.Effect<void, SubagentError>;
  readonly notifyPeers: (message: string) => Effect.Effect<void, SubagentError>;
  /** `key` is the notice's stable identity; the receiving parent shows each key once. */
  readonly deliverNotification?:
    | ((message: string, key: string) => Effect.Effect<void, SubagentError>)
    | undefined;
  /** False once turn input restarted the child after it emitted this `run_settled` event. */
  readonly isSettlementCurrent?: ((event: BackendEvent) => boolean) | undefined;
}

/** Only the cleanup owner can attest a failure; verification must never signal stale process IDs. */
export interface BackendCleanupVerifier {
  readonly canVerify: () => boolean;
  readonly diagnostic: (reason: Cause.Reason<unknown>) => SubagentCleanupDiagnostic | undefined;
  readonly verify: Effect.Effect<void, SubagentCleanupDiagnostic>;
}

export interface BackendHandle {
  readonly cleanupVerifier?: BackendCleanupVerifier | undefined;
  readonly pid?: number | undefined;
  readonly events: Queue.Dequeue<BackendEvent, Cause.Done>;
  readonly awaitExit: Effect.Effect<BackendExit, SubagentError>;
  readonly controls: BackendControls;
  readonly acknowledge: (event: BackendEvent) => void;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
  readonly cancelPending: (error: SubagentError) => void;
}

export interface BackendPreflightRequest {
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly cwd?: string | undefined;
}

export interface BackendDriver {
  readonly capabilities: ReadonlyArray<SubagentCapability>;
  readonly supportsContext: (context: SubagentContextMode) => boolean;
  readonly preflight: (
    request: BackendPreflightRequest,
  ) => Effect.Effect<void, import("../run/errors.ts").InvalidSubagentRequestError>;
  readonly spawn: (
    request: BackendLaunchRequest,
    agents?: BackendAgentMessaging,
  ) => Effect.Effect<BackendHandle, SubagentError, Scope.Scope>;
  readonly reclaimRunState?:
    | ((request: {
        readonly parentSessionId: string;
        readonly runId: string;
      }) => Effect.Effect<void, SubagentProcessError>)
    | undefined;
}
