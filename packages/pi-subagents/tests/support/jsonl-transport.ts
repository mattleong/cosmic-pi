import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import {
  acquireProcessTransport,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "../../src/boundary/process-transport.ts";
import { processCauseError } from "../../src/run/errors.ts";

type JsonlMessage = { readonly type: "message"; readonly value: Schema.Json };
export type JsonlWireEvent = ProcessWireEvent<JsonlMessage>;

interface JsonlTransportRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly writer: boolean;
}

/** A bare JSONL child on the shared process transport, without Pi's RPC and IPC layers. */
export const acquireJsonlTransport = (
  request: JsonlTransportRequest,
  runtime?: ProcessTransportRuntime,
) =>
  acquireProcessTransport<JsonlMessage, unknown, { readonly detach: () => void }>(
    {
      spawn: (spawn) =>
        spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          detached: true,
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      label: "Fixture",
      error: (operation, cause, code) =>
        processCauseError(
          `${operation} fixture`,
          cause,
          code ?? (operation === "spawn" ? "fixture_spawn_failed" : undefined),
          `Unable to ${operation} fixture process.`,
        ),
      message: (value): JsonlMessage => ({ type: "message", value }),
      confirmDetachedDescendants: request.writer,
      attach: () => ({ detach: () => {} }),
    },
    runtime,
  ).pipe(Effect.map(({ attachment: _attachment, ...transport }) => transport));
