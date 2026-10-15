import type * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { SubagentError, SubagentProcessError } from "../run/errors.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { RuntimeApiKey, SubagentCapability, SubagentUsage } from "../run/model.ts";

export type BackendResumeToken = object;

export const MAX_BACKEND_REPORT_ID_CHARS = 256;
export const MAX_BACKEND_REPORT_EVIDENCE_CHARS = 2_048;
export const MAX_BACKEND_REPORT_TEXT_CHARS = 32 * 1024;

export interface BackendReport {
  readonly runId: string;
  readonly assignmentEpoch: number;
  readonly sequence: number;
  readonly deliveryId: string;
  readonly text?: string | undefined;
  readonly evidence?: string | undefined;
}

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
  readonly sharesParentPromptCache?: boolean | undefined;
  readonly resumeToken?: BackendResumeToken | undefined;
  readonly systemPrompt: string;
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
  readonly text?: string | undefined;
  readonly errorMessage?: string | undefined;
}

export type BackendEvent =
  | {
      readonly type: "input_delivery";
      readonly assignmentEpoch: number;
      readonly sequence: number;
      readonly state: import("../run/model.ts").SteeringDeliveryState;
    }
  | { readonly type: "backend_failure"; readonly error: SubagentProcessError }
  | { readonly type: "run_started"; readonly assignmentEpoch: number }
  | {
      readonly type: "run_settled";
      readonly assignmentEpoch: number;
      readonly terminal?: BackendAssistantTerminal | undefined;
    }
  | ({ readonly type: "report" } & BackendReport)
  | { readonly type: "activity"; readonly assignmentEpoch: number }
  | { readonly type: "usage"; readonly usage: SubagentUsage }
  | {
      readonly type: "native_agent_activity";
      readonly assignmentEpoch: number;
      readonly activityId: string;
      readonly kind: string;
      readonly state: "running" | "activity" | "completed" | "failed" | "stopped";
    }
  | {
      readonly type: "assistant_message";
      readonly assignmentEpoch: number;
      readonly text?: string | undefined;
      /** The model that produced the reply, when the runtime reports one per message. */
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
      readonly type: "supervisor_question_cancelled";
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

export interface BackendControls {
  readonly initialize: Effect.Effect<BackendStartupState, SubagentError>;
  readonly start: (message: string, assignmentEpoch: number) => Effect.Effect<void, SubagentError>;
  readonly steer: (message: string) => Effect.Effect<void, SubagentError>;
  readonly interrupt: Effect.Effect<void, SubagentError>;
  readonly renameDisplay: (name: string) => Effect.Effect<void, SubagentError>;
  readonly reply: (requestId: string, message: string) => Effect.Effect<void, SubagentError>;
  readonly notifyPeers: (message: string) => Effect.Effect<void, SubagentError>;
  readonly deliverNotification?:
    | ((message: string) => Effect.Effect<void, SubagentError>)
    | undefined;
}

export interface BackendHandle {
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
  readonly closeOnReport: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly cwd?: string | undefined;
}

export interface BackendDriver {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly capabilities: ReadonlyArray<SubagentCapability>;
  readonly supportsContext: (context: SubagentContextMode) => boolean;
  readonly preflight: (
    request: BackendPreflightRequest,
  ) => Effect.Effect<void, import("../run/errors.ts").InvalidSubagentRequestError>;
  readonly spawn: (
    request: BackendLaunchRequest,
  ) => Effect.Effect<BackendHandle, SubagentError, Scope.Scope>;
  readonly reclaimRunState?:
    | ((request: {
        readonly parentSessionId: string;
        readonly runId: string;
      }) => Effect.Effect<void, SubagentProcessError>)
    | undefined;
}
