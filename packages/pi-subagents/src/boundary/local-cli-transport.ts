// Native CLI frame limits and immediate parser-overflow termination policy, shared by the local
// Claude/Codex adapters.
// process-transport.ts owns shared spawn, bounded queues, writes, and process-tree release.
// This boundary owns no harness state and never imports the LocalCliProcess service.
import * as Effect from "effect/Effect";
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
  type ProcessTransportHandle,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "./process-transport.ts";

type LocalCliMessage = { readonly type: "message"; readonly value: unknown };

export type LocalCliWireEvent = ProcessWireEvent<LocalCliMessage>;

export type LocalCliOutboundFrame =
  | ClaudeUserFrame
  | ClaudeControlRequestFrame
  | CodexRequest
  | CodexInitializedNotification;

export type LocalCliHandle = ProcessTransportHandle<LocalCliMessage, LocalCliOutboundFrame>;

export interface LocalCliTransportRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
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
      message: (value): LocalCliWireEvent => ({ type: "message", value }),
      maxOutboundBytes: MAX_PROCESS_LINE_BYTES,
      terminateOnParserOverflow: true,
      synchronousWriteFailure: "defect",
      attach: () => ({ detach: () => {} }),
    },
    runtime,
  );
  const handle: LocalCliHandle = transport;
  return handle;
});
