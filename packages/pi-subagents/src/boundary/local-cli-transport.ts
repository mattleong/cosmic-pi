import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type {
  CodexInitializedNotification,
  CodexRequest,
} from "../backend/local-codex-protocol.ts";
import type {
  ClaudeControlRequestFrame,
  ClaudeUserFrame,
} from "../backend/local-claude-protocol.ts";
import { processCauseError, type SubagentProcessError } from "../run/errors.ts";
import {
  acquireProcessTransport,
  MAX_PROCESS_LINE_BYTES,
  type ProcessTransportHandle,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "./process-transport.ts";

type LocalCliMessage = { readonly type: "message"; readonly value: Schema.Json };

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
  readonly platform?: NodeJS.Platform | undefined;
}

export const processError = (
  operation: string,
  cause?: unknown,
  code?: string,
): SubagentProcessError =>
  processCauseError(operation, cause, code, `Unable to ${operation} local CLI process.`);

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
      error: (operation, cause, code) =>
        processError(
          `${operation} local CLI`,
          cause,
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
