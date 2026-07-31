import type * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { SubagentError, SubagentProcessError } from "../run/errors.ts";
import type {
  SubagentCapability,
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentUsage,
  SubagentWriteIntent,
} from "../run/model.ts";

/** Backend-owned continuation evidence. Orchestration stores and returns it without inspection. */
export type BackendResumeToken = object;

export const MAX_BACKEND_REPORT_ID_CHARS = 256;
export const MAX_BACKEND_REPORT_EVIDENCE_CHARS = 2_048;
export const MAX_BACKEND_REPORT_TEXT_CHARS = 32 * 1024;

/**
 * Adapter-normalized report delivery. `assignmentEpoch` is supplied by orchestration; `sequence`
 * is positive and monotonically increasing for one run. Adapters reuse the same bounded
 * `deliveryId` and sequence when retrying a delivery.
 * Evidence is opaque adapter ownership/correlation data, never a project path or report file.
 */
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
  readonly closeOnReport: boolean;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly runtimeApiKey?: string | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string | undefined;
  readonly parentLeafId?: string | undefined;
  readonly resumeToken?: BackendResumeToken | undefined;
  readonly systemPrompt: string;
}

export interface BackendStartupState {
  readonly model?: string | undefined;
  readonly effort: SubagentEffort;
  readonly sessionId: string;
  /** Optional backend metadata retained for status/UX; never interpreted by orchestration. */
  readonly sessionFile?: string | undefined;
  readonly resumeToken?: BackendResumeToken | undefined;
}

export type BackendEvent =
  | { readonly type: "run_started"; readonly assignmentEpoch: number }
  | { readonly type: "run_settled"; readonly assignmentEpoch: number }
  | ({ readonly type: "report" } & BackendReport)
  | { readonly type: "activity"; readonly assignmentEpoch: number }
  | {
      readonly type: "assistant_message";
      readonly assignmentEpoch: number;
      readonly text?: string | undefined;
      readonly usage: SubagentUsage;
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
      readonly source: "runtime-extension";
      readonly message: string;
    }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string | undefined;
      readonly diagnostic: string;
    };

export type BackendExit = Extract<BackendEvent, { readonly type: "exit" }>;

/** Runtime-independent controls advertised by a backend driver's capabilities. */
export interface BackendControls {
  readonly initialize: Effect.Effect<BackendStartupState, SubagentError>;
  readonly start: (message: string, assignmentEpoch: number) => Effect.Effect<void, SubagentError>;
  readonly steer: (message: string) => Effect.Effect<void, SubagentError>;
  readonly interrupt: Effect.Effect<void, SubagentError>;
  readonly renameDisplay: (name: string) => Effect.Effect<void, SubagentError>;
  readonly reply: (requestId: string, message: string) => Effect.Effect<void, SubagentError>;
  readonly notifyPeers: (message: string) => Effect.Effect<void, SubagentError>;
}

export interface BackendHandle {
  readonly pid?: number | undefined;
  readonly events: Queue.Dequeue<BackendEvent, Cause.Done>;
  readonly awaitExit: Effect.Effect<BackendExit, SubagentError>;
  readonly controls: BackendControls;
  /** Release transport ownership for one event after orchestration has consumed it. Must not throw. */
  readonly acknowledge: (event: BackendEvent) => void;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
  /** Settle in-flight transport requests before process cleanup begins. Must not throw. */
  readonly cancelPending: (error: SubagentError) => void;
}

export interface BackendPreflightRequest {
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly closeOnReport: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  /** Canonical assigned cwd when required by backend capability policy. */
  readonly cwd?: string | undefined;
}

export interface BackendDriver {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly capabilities: ReadonlyArray<SubagentCapability>;
  readonly supportsContext: (context: SubagentContextMode) => boolean;
  /** Bounded readiness only. It must not acquire run, process, lease, or supervisor ownership. */
  readonly preflight?: (
    request: BackendPreflightRequest,
  ) => Effect.Effect<void, import("../run/errors.ts").InvalidSubagentRequestError>;
  readonly spawn: (
    request: BackendLaunchRequest,
  ) => Effect.Effect<BackendHandle, SubagentError, Scope.Scope>;
}
