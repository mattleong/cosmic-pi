// Native CLI frame limits and immediate parser-overflow termination policy, shared by the local
// Claude/Codex adapters.
// process-transport.ts owns shared spawn, bounded queues, writes, and process-tree release.
// This boundary owns no harness state and never imports the LocalCliProcess service.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type {
  CodexInitializedNotification,
  CodexRequest,
} from "../backend/local-codex-protocol.ts";
import type {
  ClaudeControlRequestFrame,
  ClaudeUserFrame,
} from "../backend/local-claude-protocol.ts";
import { processCauseError, SubagentProcessError } from "../run/errors.ts";
import {
  acquireProcessTransport,
  MAX_PROCESS_LINE_BYTES,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "./process-transport.ts";

/** Outbound frames are locally constructed protocol values serialized as one pure JSONL line. */
const encodeOutboundFrame = (value: LocalCliOutboundFrame): string => `${JSON.stringify(value)}\n`;

export type LocalCliWireEvent = ProcessWireEvent<{
  readonly type: "message";
  readonly value: unknown;
  readonly bytes?: number;
}>;

export type LocalCliOutboundFrame =
  | ClaudeUserFrame
  | ClaudeControlRequestFrame
  | CodexRequest
  | CodexInitializedNotification;

export interface LocalCliHandle {
  readonly pid: number;
  readonly events: Queue.Dequeue<LocalCliWireEvent, Cause.Done>;
  readonly awaitExit: Effect.Effect<
    Extract<LocalCliWireEvent, { readonly type: "exit" }>,
    SubagentProcessError
  >;
  readonly send: (value: LocalCliOutboundFrame) => Effect.Effect<void, SubagentProcessError>;
  readonly acknowledge: (event: LocalCliWireEvent) => void;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

export interface LocalCliTransportRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly maxLineBytes?: number | undefined;
  /** Defaults to "defect". */
  readonly synchronousWriteFailure?: "not_sent" | "defect" | undefined;
  /** Package-test seam only. */
  readonly platform?: NodeJS.Platform | undefined;
}

export const processError = <ErrorInput>(
  operation: string,
  error?: ErrorInput,
  code?: string,
): SubagentProcessError =>
  processCauseError(operation, error, code, `Unable to ${operation} local CLI process.`);

/** The native adapters retain frame limits and immediate parser-overflow termination. */
export const acquireLocalCliTransport = Effect.fn("LocalCliTransport.acquire")(function* (
  request: LocalCliTransportRequest,
  runtime?: ProcessTransportRuntime,
) {
  const platform = request.platform ?? process.platform;
  const { attachment: _attachment, ...transport } = yield* acquireProcessTransport(
    {
      spawn: (spawn) =>
        spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: platform !== "win32",
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }),
      platform,
      label: "Local CLI",
      error: (operation, error, code) =>
        processError(
          `${operation} local CLI`,
          error,
          code ?? (operation === "spawn" ? "local_cli_spawn_failed" : undefined),
        ),
      message: (value, bytes): LocalCliWireEvent => ({ type: "message", value, bytes }),
      encode: encodeOutboundFrame,
      maxOutboundBytes: MAX_PROCESS_LINE_BYTES,
      maxLineBytes: request.maxLineBytes,
      terminateOnParserOverflow: true,
      synchronousWriteFailure: request.synchronousWriteFailure ?? "defect",
      attach: () => ({ value: undefined, detach: () => {} }),
    },
    runtime,
  );
  return transport;
});
