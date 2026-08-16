// Delegated-Pi to packaged supervisor MCP helper process boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import * as Predicate from "effect/Predicate";

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const MAX_LINE_BYTES = 512 * 1024;
const MAX_PENDING = 16;
const CALL_TIMEOUT_MILLIS = 15_000;
const QUESTION_TIMEOUT_MILLIS = 10 * 60_000;
const PRE_OPEN_CLEANUP_TIMEOUT_MILLIS = 1_000;
const packagedHelperPath = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));

interface PendingCall {
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export type SupervisorToolName =
  | "supervisor_progress"
  | "supervisor_warning"
  | "supervisor_question"
  | "supervisor_submit_report";

export interface SupervisorMessageArguments {
  readonly message: string;
}

export interface SupervisorReportArguments {
  readonly delivery_id: string;
  readonly report: string;
}

export interface SupervisorToolArgumentsByName {
  readonly supervisor_progress: SupervisorMessageArguments;
  readonly supervisor_warning: SupervisorMessageArguments;
  readonly supervisor_question: SupervisorMessageArguments;
  readonly supervisor_submit_report: SupervisorReportArguments;
}

interface BridgeInitializeRequest {
  readonly jsonrpc: "2.0";
  readonly id: "pi-bridge-initialize";
  readonly method: "initialize";
  readonly params: {
    readonly protocolVersion: "2025-06-18";
    readonly capabilities: object;
    readonly clientInfo: { readonly name: "pi-subagents-pi-bridge"; readonly version: "1.0.0" };
  };
}

interface BridgeInitializedNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/initialized";
  readonly params: object;
}

interface BridgeCancelledNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/cancelled";
  readonly params: { readonly requestId: string; readonly reason: string };
}

interface BridgeToolCallRequest<Name extends SupervisorToolName = SupervisorToolName> {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "tools/call";
  readonly params: {
    readonly name: Name;
    readonly arguments: SupervisorToolArgumentsByName[Name];
  };
}

type BridgeOutboundMessage =
  | BridgeInitializeRequest
  | BridgeInitializedNotification
  | BridgeCancelledNotification
  | BridgeToolCallRequest;

const BridgeResponseDiscriminant = Schema.Struct({ id: Schema.optional(Schema.Unknown) });
const BridgeResponse = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number.check(Schema.isFinite(), Schema.isInt()),
      message: Schema.String.check(Schema.isMaxLength(64 * 1024)),
      data: Schema.optional(Schema.Unknown),
    }),
  ),
});
const BridgeInitializeResult = Schema.Struct({
  protocolVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  capabilities: Schema.Struct({ tools: Schema.Struct({ listChanged: Schema.Boolean }) }),
  serverInfo: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
});
const BridgeTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMaxLength(64 * 1024)),
});
const BridgeToolResult = Schema.Struct({
  content: Schema.Array(BridgeTextContent),
  isError: Schema.optional(Schema.Boolean),
});

export interface PiSupervisorBridgeClient {
  readonly call: <Name extends SupervisorToolName>(
    name: Name,
    input: SupervisorToolArgumentsByName[Name],
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly close: () => void;
}

const fixedError = (message: string): Error => new Error(message);

export interface PiSupervisorBridgeOpenOptions {
  /** Package-test seam only; production always uses the packaged helper. */
  readonly helperPath?: string | undefined;
  readonly initializeTimeoutMillis?: number | undefined;
}

export const openPiSupervisorBridge = (
  configPath: string,
  options: PiSupervisorBridgeOpenOptions = {},
): Promise<PiSupervisorBridgeClient> =>
  new Promise((resolveOpen, rejectOpen) => {
    if (
      !isAbsolute(configPath) ||
      configPath.length < 1 ||
      configPath.length > 4_096 ||
      configPath.includes("\0") ||
      configPath.includes("\r") ||
      configPath.includes("\n")
    ) {
      rejectOpen(fixedError("Private supervisor configuration path is invalid."));
      return;
    }
    const child = spawn(
      process.execPath,
      [options.helperPath ?? packagedHelperPath, "--config", configPath],
      {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let nextId = 1;
    let buffered = "";
    let closed = false;
    let openSettled = false;
    let preOpenFailure: Error | undefined;
    let preOpenCleanupTimer: NodeJS.Timeout | undefined;
    let initialized = false;
    let pendingWrites = 0;
    let writeTail: Promise<void> = Promise.resolve();
    const pending = new Map<string, PendingCall>();

    const failAll = (message: string) => {
      const error = fixedError(message);
      if (!closed) {
        closed = true;
        for (const call of pending.values()) {
          clearTimeout(call.timer);
          call.reject(error);
        }
        pending.clear();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.kill();
      }
      // Every failure before resolveOpen, including initialize response/timeout/write and the
      // initialized notification, converges here. Reject only after child exit is observed so a
      // failed open cannot return while an authenticated helper remains live.
      if (!openSettled) {
        preOpenFailure ??= error;
        if (child.exitCode !== null || child.signalCode !== null) {
          if (preOpenCleanupTimer) clearTimeout(preOpenCleanupTimer);
          preOpenCleanupTimer = undefined;
          openSettled = true;
          rejectOpen(preOpenFailure);
        } else {
          child.kill("SIGKILL");
          if (!preOpenCleanupTimer) {
            preOpenCleanupTimer = setTimeout(() => {
              if (openSettled) return;
              child.kill("SIGKILL");
              openSettled = true;
              rejectOpen(
                fixedError(
                  "Private supervisor bridge open failed and helper cleanup was not confirmed.",
                ),
              );
            }, PRE_OPEN_CLEANUP_TIMEOUT_MILLIS);
            preOpenCleanupTimer.unref();
          }
        }
      }
    };
    child.stdin?.on("error", () => failAll("Private supervisor bridge input transport failed."));

    const write = (value: BridgeOutboundMessage): Promise<void> => {
      if (closed || !child.stdin || child.stdin.destroyed || pendingWrites >= 32)
        return Promise.reject(fixedError("Private supervisor bridge input is unavailable."));
      const line = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
        return Promise.reject(fixedError("Private supervisor bridge request exceeds its bound."));
      pendingWrites += 1;
      const operation = writeTail.then(
        () =>
          new Promise<void>((resolveWrite, rejectWrite) => {
            child.stdin?.write(line, "utf8", (error) =>
              error
                ? rejectWrite(
                    fixedError("Private supervisor bridge delivery is outcome-uncertain."),
                  )
                : resolveWrite(),
            );
          }),
      );
      writeTail = operation
        .catch(() => undefined)
        .then(() => {
          pendingWrites = Math.max(0, pendingWrites - 1);
        });
      return operation;
    };
    const request = <Name extends SupervisorToolName>(
      name: Name,
      input: SupervisorToolArgumentsByName[Name],
      timeoutMillis: number,
      signal?: AbortSignal,
    ): Promise<string> =>
      new Promise((resolveRequest, rejectRequest) => {
        if (closed || pending.size >= MAX_PENDING) {
          rejectRequest(fixedError("Private supervisor bridge concurrent-call capacity is full."));
          return;
        }
        const id = `pi-bridge-${nextId++}`;
        let aborted = false;
        const abort = () => {
          if (aborted) return;
          aborted = true;
          const call = pending.get(id);
          if (!call) return;
          pending.delete(id);
          clearTimeout(call.timer);
          void write({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: "Pi tool call cancelled" },
          }).catch(() => undefined);
          call.reject(fixedError("Private supervisor request was cancelled."));
        };
        const timer = setTimeout(() => {
          const call = pending.get(id);
          if (!call) return;
          pending.delete(id);
          signal?.removeEventListener("abort", abort);
          call.reject(
            fixedError("Private supervisor request timed out; delivery outcome may be uncertain."),
          );
        }, timeoutMillis);
        timer.unref();
        pending.set(id, {
          resolve: (text) => {
            signal?.removeEventListener("abort", abort);
            resolveRequest(text);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", abort);
            rejectRequest(error);
          },
          timer,
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        void write({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: input },
        }).catch((error) => {
          const call = pending.get(id);
          if (!call) return;
          pending.delete(id);
          clearTimeout(call.timer);
          signal?.removeEventListener("abort", abort);
          call.reject(
            error instanceof Error ? error : fixedError("Private supervisor bridge write failed."),
          );
        });
      });

    const onLine = (line: string) => {
      let value: unknown;
      try {
        // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
        value = JSON.parse(line) as unknown;
      } catch {
        failAll("Private supervisor bridge returned malformed JSON.");
        return;
      }
      const discriminant = Schema.decodeUnknownOption(BridgeResponseDiscriminant)(value);
      if (Option.isNone(discriminant)) {
        failAll("Private supervisor bridge returned an invalid response.");
        return;
      }
      const id = Predicate.isString(discriminant.value.id) ? discriminant.value.id : undefined;
      if (!id) return;
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      clearTimeout(call.timer);
      const response = Schema.decodeUnknownOption(BridgeResponse)(value);
      if (Option.isNone(response)) {
        call.reject(fixedError("Private supervisor helper returned an invalid response."));
        return;
      }
      if (response.value.error) {
        call.reject(fixedError("Private supervisor helper rejected the request."));
        return;
      }
      if (id === "pi-bridge-initialize") {
        const result = Schema.decodeUnknownOption(BridgeInitializeResult)(response.value.result);
        if (Option.isNone(result)) {
          call.reject(fixedError("Private supervisor helper returned an invalid result."));
          return;
        }
        initialized = true;
        call.resolve("initialized");
        return;
      }
      const result = Schema.decodeUnknownOption(BridgeToolResult)(response.value.result);
      const text = Option.isSome(result) ? result.value.content[0]?.text : undefined;
      if (Option.isNone(result) || result.value.isError === true || text === undefined) {
        call.reject(fixedError(text ?? "Private supervisor helper rejected the call."));
        return;
      }
      call.resolve(text);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (closed) return;
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES * 2) {
        failAll("Private supervisor bridge output exceeded its bounded buffer.");
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          failAll("Private supervisor bridge response exceeded its line bound.");
          return;
        }
        if (line) onLine(line);
        newline = buffered.indexOf("\n");
      }
    });
    child.once("error", () => failAll("Unable to start the packaged private supervisor helper."));
    child.once("close", () => failAll("The packaged private supervisor helper closed."));

    const initializeTimer = setTimeout(() => {
      if (!pending.has("pi-bridge-initialize")) return;
      pending.delete("pi-bridge-initialize");
      failAll("Private supervisor bridge initialization timed out.");
    }, options.initializeTimeoutMillis ?? CALL_TIMEOUT_MILLIS);
    initializeTimer.unref();
    const initializedPromise = new Promise<string>((resolveInitialize, rejectInitialize) => {
      pending.set("pi-bridge-initialize", {
        resolve: resolveInitialize,
        reject: rejectInitialize,
        timer: initializeTimer,
      });
      void write({
        jsonrpc: "2.0",
        id: "pi-bridge-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pi-subagents-pi-bridge", version: "1.0.0" },
        },
      }).catch((error) => {
        rejectInitialize(
          error instanceof Error ? error : fixedError("Private supervisor bridge write failed."),
        );
      });
    });
    void initializedPromise.then(
      () => {
        void write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).then(
          () => {
            if (closed) return;
            openSettled = true;
            resolveOpen({
              call: (name, input, signal) => {
                if (!initialized)
                  return Promise.reject(
                    fixedError("Private supervisor bridge is not initialized."),
                  );
                return request(
                  name,
                  input,
                  name === "supervisor_question" ? QUESTION_TIMEOUT_MILLIS : CALL_TIMEOUT_MILLIS,
                  signal,
                );
              },
              close: () => failAll("Private supervisor bridge closed."),
            });
          },
          (error) =>
            failAll(
              error instanceof Error
                ? error.message
                : "Private supervisor initialized notification failed.",
            ),
        );
      },
      (error) =>
        failAll(
          error instanceof Error
            ? error.message
            : "Private supervisor bridge initialization failed.",
        ),
    );
  });
