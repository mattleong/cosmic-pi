// Native CLI frame limits and immediate parser-overflow termination policy.
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
} from "./process-transport.ts";

/** Outbound frames are locally constructed protocol values serialized as one pure JSONL line. */
const encodeOutboundFrame = (value: LocalCliOutboundFrame): string => `${JSON.stringify(value)}\n`;

export type LocalCliWireEvent =
  | { readonly type: "message"; readonly value: unknown }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string | undefined;
      readonly stderr: string;
    };

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
  /** Package-test seam only. */
  readonly platform?: NodeJS.Platform | undefined;
}

const processError = <ErrorInput>(
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
      message: (value): LocalCliWireEvent => ({ type: "message", value }),
      encode: encodeOutboundFrame,
      maxOutboundBytes: MAX_PROCESS_LINE_BYTES,
      terminateOnParserOverflow: true,
      synchronousWriteFailure: "defect",
      attach: () => ({ value: undefined, detach: () => {} }),
    },
    runtime,
  );
  return transport;
});
