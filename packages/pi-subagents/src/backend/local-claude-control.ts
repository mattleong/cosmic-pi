import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import { processError, type SubagentError } from "../run/errors.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import type { LocalClaudeHandleContext, PendingInterrupt } from "./local-claude-context.ts";
import {
  claudeInitializeFrame,
  claudeMcpStatusFrame,
  decodeClaudeInitializeControlResponse,
  decodeClaudeMcpStatusControlResponse,
  type ClaudeControlRequestFrame,
  type ClaudeProtocolEvent,
} from "./local-claude-protocol.ts";
import { correlatedRequest } from "./driver-shared.ts";
import type { BackendLaunchRequest } from "./model.ts";

const CONTROL_TIMEOUT = "10 seconds";
const MCP_READY_ATTEMPTS = 100;
const INITIALIZATION_PROBE = "pi-subagents native initialization probe";

export type ClaudeInitProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "init" }>;

const nativeInitializationFailure = (
  native: ClaudeInitProtocolEvent,
  request: Pick<BackendLaunchRequest, "model" | "cwd">,
  resolvedModel: string,
) => {
  if (native.model !== request.model && native.model !== resolvedModel)
    return processError(
      "initialize",
      "claude_model_mismatch",
      `Claude Code selected model ${native.model} instead of required model ${request.model}.`,
    );
  if (native.cwd !== request.cwd)
    return processError(
      "initialize",
      "claude_cwd_mismatch",
      "Claude Code initialized outside the canonical assigned working directory.",
    );
  if (!native.sessionId || native.hasMcpServerErrors)
    return processError(
      "initialize",
      "claude_native_init_invalid",
      native.hasMcpServerErrors
        ? "Claude Code rejected part of the mandatory private MCP configuration."
        : "Claude Code did not provide a native session identity.",
    );
  return undefined;
};
type ClaudeControlResponseEvent = Extract<
  ClaudeProtocolEvent,
  { readonly type: "control_response" }
>;

interface PendingControl {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

export const localClaudeControl = (
  request: BackendLaunchRequest,
  context: Pick<LocalClaudeHandleContext, "child" | "inputs" | "release">,
  nativeInitialization: Deferred.Deferred<ClaudeInitProtocolEvent, SubagentError>,
) => {
  const { child, inputs, release } = context;
  const controlResponses = new Map<string, PendingControl>();
  let nextControlId = 1;
  let initializationStarted = false;

  const onControlResponse = (event: ClaudeControlResponseEvent, raw: LocalCliWireEvent) => {
    const pending = controlResponses.get(event.requestId);
    if (!pending) return release(raw);
    controlResponses.delete(event.requestId);
    Deferred.doneUnsafe(
      pending.deferred,
      event.success
        ? Effect.succeed(event.response)
        : Effect.fail(
            processError(
              pending.operation,
              `${pending.operation}_rejected`,
              event.diagnostic ?? `Claude Code rejected ${pending.operation}.`,
            ),
          ),
    );
    return release(raw);
  };

  const sendControl = (operation: string, frame: ClaudeControlRequestFrame) =>
    child
      .send(frame)
      .pipe(
        Effect.mapError((error) =>
          error.code === "transport_outcome_uncertain"
            ? processError(
                operation,
                `${operation}_outcome_uncertain`,
                `Claude ${operation} may already have applied; it will not be retried. (${error.message})`,
              )
            : error,
        ),
      );

  const requestControl = (
    operation: string,
    makeFrame: (requestId: string) => ClaudeControlRequestFrame,
  ): Effect.Effect<unknown, SubagentError> =>
    correlatedRequest({
      timeout: CONTROL_TIMEOUT,
      register: (deferred) => {
        const requestId = `${operation}-${nextControlId++}`;
        controlResponses.set(requestId, { operation, deferred });
        return {
          frame: makeFrame(requestId),
          unregister: Effect.sync(() => void controlResponses.delete(requestId)),
        };
      },
      send: (frame) => sendControl(operation, frame),
      timeoutError: () =>
        processError(
          operation,
          `${operation}_outcome_uncertain`,
          `Claude ${operation} was sent but no correlated native response arrived; it will not be retried.`,
        ),
    });

  const initialize = Effect.gen(function* () {
    if (initializationStarted)
      return yield* processError(
        "initialize",
        "claude_initialize_repeated",
        "Claude Code initialization may only be performed once per backend handle.",
      );
    initializationStarted = true;
    const response = yield* requestControl("initialize", claudeInitializeFrame);
    const advertised = yield* decodeClaudeInitializeControlResponse(response).pipe(
      Effect.mapError(() =>
        processError(
          "initialize",
          "claude_initialize_invalid",
          "Claude Code returned an invalid initialize control response.",
        ),
      ),
    );
    yield* inputs.send(INITIALIZATION_PROBE, 0, "initialize", false);
    const native = yield* Deferred.await(nativeInitialization).pipe(
      Effect.timeoutOrElse({
        duration: CONTROL_TIMEOUT,
        orElse: () =>
          Effect.fail(
            processError(
              "initialize",
              "claude_native_init_missing",
              "Claude Code did not emit its mandatory native system/init event.",
            ),
          ),
      }),
    );
    const resolvedModel =
      advertised.models.find((model) => model.value === request.model)?.resolvedModel ??
      request.model;
    const nativeFailure = nativeInitializationFailure(native, request, resolvedModel);
    if (nativeFailure) return yield* nativeFailure;
    return yield* awaitSupervisorMcp(native);
  });

  const awaitSupervisorMcp = (native: ClaudeInitProtocolEvent) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < MCP_READY_ATTEMPTS; attempt += 1) {
        const status = yield* requestControl("mcp_status", claudeMcpStatusFrame).pipe(
          Effect.flatMap((value) =>
            decodeClaudeMcpStatusControlResponse(value).pipe(
              Effect.mapError(() =>
                processError(
                  "initialize",
                  "claude_mcp_status_invalid",
                  "Claude Code returned an invalid mandatory MCP status response.",
                ),
              ),
            ),
          ),
        );
        const server = status.mcpServers.find(
          (candidate) => candidate.name === SUPERVISOR_MCP_REGISTRATION,
        );
        if (server?.status === "connected") {
          const inventory = new Set(server.tools?.map((tool) => tool.name));
          if (!SUPERVISOR_MCP_TOOL_NAMES.every((tool) => inventory.has(tool)))
            return yield* processError(
              "initialize",
              "claude_supervisor_tools_missing",
              "Claude Code connected the private supervisor MCP server without its mandatory tool inventory.",
            );
          return { model: native.model, effort: request.effort, sessionId: native.sessionId };
        }
        if (server && server.status !== "pending" && server.status !== "connecting") break;
        yield* Effect.sleep("50 millis");
      }
      return yield* processError(
        "initialize",
        "claude_supervisor_mcp_unavailable",
        "Claude Code did not connect the mandatory pi_subagents_supervisor MCP server.",
      );
    });

  const interruptRequest = (): Pick<PendingInterrupt, "requestId" | "response"> => {
    const requestId = `interrupt-${nextControlId++}`;
    const response = Deferred.makeUnsafe<unknown, SubagentError>();
    controlResponses.set(requestId, { operation: "interrupt", deferred: response });
    return { requestId, response };
  };

  const cancel = (error: SubagentError) => {
    for (const pending of controlResponses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    controlResponses.clear();
  };

  return {
    onControlResponse,
    sendControl,
    initialize,
    interruptRequest,
    forget: (requestId: string) => controlResponses.delete(requestId),
    cancel,
  };
};
