import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  makeMcpCodeModeHost,
  mcpCodeModeSessionId,
  type McpCodeModeHost,
} from "../boundary/host-code-mode.ts";
import {
  makeMcpErrorReceipts,
  mcpFailureReply,
  type McpActivationMarker,
} from "../boundary/host-tool-result.ts";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import {
  makeMcpLayer,
  type McpApplication,
  type McpLayerInput,
  type McpRuntimeError,
} from "../layer.ts";
import { buildMcpTool, type McpToolDefinition } from "../tools/controller.ts";
import type { McpGatewayExecution, McpGatewayReply } from "../tools/model.ts";
import { McpExecution, type McpExecutionContract } from "../tools/service.ts";

// Error-label decoding never traverses a rejected argument payload. The shared
// execution decoder remains the only authority for admitting the complete request.
const ErrorActionSchema = Schema.Struct({
  action: Schema.Literals([
    "status",
    "connect",
    "disconnect",
    "refresh",
    "tools.list",
    "tools.search",
    "tools.describe",
    "tools.call",
    "resources.list",
    "resources.templates",
    "resources.read",
    "prompts.list",
    "prompts.get",
    "result.read",
  ]),
});

interface McpSessionInput extends McpLayerInput {
  readonly ctx: ExtensionContext;
  readonly sessionId: string | undefined;
  readonly owner: McpActivationMarker;
}
export interface McpApplicationBoundaries {
  readonly makeLayer: typeof makeMcpLayer;
  readonly loadSettings: (cwd: string, trusted: boolean, signal: AbortSignal) => Promise<void>;
  readonly wrapTool: (tool: McpToolDefinition) => McpToolDefinition;
}
const liveBoundaries: McpApplicationBoundaries = {
  makeLayer: makeMcpLayer,
  loadSettings: (cwd, trusted, signal) =>
    loadCodePreviewSettings(cwd, trusted, signal).then(() => undefined),
  wrapTool: (tool) => withCodePreviewShell(tool),
};
export interface McpCommandPort {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, McpApplication>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly capture: (ctx: ExtensionContext) => () => boolean;
}

/** The only MCP Effect-to-Promise boundary. The core slot owns all runtime transitions. */
export const makeMcpLifecycle = (
  pi: ExtensionAPI,
  boundaries: McpApplicationBoundaries = liveBoundaries,
) => {
  const receipts = makeMcpErrorReceipts();
  let host: McpCodeModeHost | undefined;
  let active:
    | {
        readonly input: McpSessionInput;
        readonly token: number;
        readonly execution: McpExecutionContract;
      }
    | undefined;
  let ownedSource: string | undefined;
  let expectedActive = false;
  let userDeactivated = false;
  let previousSessionId: string | undefined;

  const visibleTool = () => pi.getAllTools().find((tool) => tool.name === "mcp");
  const ownsTool = (): boolean =>
    invokeHostCallback(() => {
      const tool = visibleTool();
      return (
        tool !== undefined &&
        ownedSource !== undefined &&
        JSON.stringify(tool.sourceInfo) === ownedSource
      );
    }, false);
  const toolActive = (): boolean =>
    ownsTool() && invokeHostCallback(() => pi.getActiveTools().includes("mcp"), false);
  const observeUserIntent = (): void => {
    if (!ownsTool()) return;
    if (toolActive()) userDeactivated = false;
    else if (expectedActive) userDeactivated = true;
  };
  const deactivateTool = (): void => {
    if (ownsTool())
      invokeHostCallback(
        () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "mcp")),
        undefined,
      );
    expectedActive = false;
  };
  const current = (input: McpSessionInput, token: number) =>
    active?.input === input && slot.isCurrent(token);

  const rawExecute = <Input>(
    input: McpSessionInput,
    token: number,
    execution: McpExecutionContract,
    request: Input,
    signal: AbortSignal | undefined,
    maxOutputBytes: number,
    images: boolean,
  ): Promise<McpGatewayExecution> => {
    if (!current(input, token))
      return Promise.reject(boundaryError("stale", "not-sent", "MCP session is no longer active."));
    if (signal?.aborted)
      return Promise.reject(boundaryError("cancelled", "not-sent", "MCP operation was cancelled."));
    // Running the Result, not the failing Effect, preserves the typed error rather
    // than exposing Effect's FiberFailure wrapper to Code Mode certainty handling.
    return slot
      .run(Effect.result(execution.execute(request, { maxOutputBytes, images })), signal)
      .then(
        (result) => {
          if (Result.isFailure(result)) throw result.failure;
          if (!current(input, token))
            throw boundaryError("stale", result.success.reply.outcome, "MCP session was replaced.");
          return result.success;
        },
        () => {
          throw boundaryError(
            signal?.aborted ? "cancelled" : "unavailable",
            "unknown",
            "MCP operation did not return a confirmed outcome.",
          );
        },
      );
  };

  const slot = makePiSessionRuntimeSlot<
    McpSessionInput,
    McpApplication,
    never,
    McpRuntimeError,
    McpExecutionContract
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(pi, boundaries.makeLayer(input), {
        agentDirectory: getAgentDir,
        packageName: "pi-mcp",
      }),
    startup: (input) =>
      Effect.gen(function* () {
        const execution = yield* McpExecution;
        yield* bestEffortHostBootstrap("pi-mcp.preview-settings", (signal) =>
          boundaries.loadSettings(input.cwd, input.projectTrusted && input.isTrusted(), signal),
        );
        return execution;
      }),
    onActivated: (input, token, execution) => {
      // Detect a foreign gateway immediately before mutation as well as before startup.
      const conflict = invokeHostCallback(() => visibleTool() !== undefined && !ownsTool(), true);
      if (conflict) {
        notifyAtHostBoundary(
          input.ctx,
          "MCP tool name conflicts with another extension. Its tool was left unchanged.",
          "warning",
        );
        return;
      }
      active = { input, token, execution };
      receipts.activate(input.owner);
      let wrapped: McpToolDefinition | undefined;
      try {
        wrapped = boundaries.wrapTool(
          buildMcpTool({
            owner: input.owner,
            receipts,
            execute: (_callId, request, signal, maxOutputBytes, images) =>
              rawExecute(input, token, execution, request, signal, maxOutputBytes, images).catch(
                (error) => {
                  if (!current(input, token))
                    throw boundaryError("stale", "unknown", "MCP session was replaced.");
                  const failure =
                    error instanceof McpBoundaryError
                      ? error
                      : boundaryError("unavailable", "unknown", "MCP operation failed.");
                  const action = invokeHostCallback(
                    () =>
                      Option.getOrUndefined(Schema.decodeUnknownOption(ErrorActionSchema)(request))
                        ?.action ?? "status",
                    "status",
                  );
                  return { reply: mcpFailureReply(action, failure), images: [] };
                },
              ),
          }),
        );
        pi.registerTool(wrapped);
        const installed = visibleTool();
        if (installed === undefined)
          throw boundaryError("unavailable", "not-sent", "MCP tool was not installed.");
        ownedSource = JSON.stringify(installed.sourceInfo);
        const names = pi.getActiveTools().filter((name) => name !== "mcp");
        pi.setActiveTools(userDeactivated ? names : [...names, "mcp"]);
        expectedActive = !userDeactivated;
      } catch {
        // Pi may mutate its registry before refresh throws. Record only the definition
        // we actually attempted so a later start can retry without treating it as foreign.
        const installed = invokeHostCallback(visibleTool, undefined);
        if (wrapped !== undefined && installed?.parameters === wrapped.parameters) {
          ownedSource = invokeHostCallback(() => JSON.stringify(installed.sourceInfo), undefined);
        }
        active = undefined;
        receipts.deactivate();
        deactivateTool();
        notifyAtHostBoundary(input.ctx, "MCP failed to register its tool.", "warning");
        return;
      }
      host = makeMcpCodeModeHost(pi.events);
      host.activate({
        sessionId: input.sessionId,
        tokenCurrent: () => current(input, token),
        toolActive,
        trusted: () => input.isTrusted() && execution.isAvailable(),
        execute: (_callId, request, signal, maxOutputBytes): Promise<McpGatewayReply> =>
          rawExecute(input, token, execution, request, signal, maxOutputBytes, false).then(
            (result) => result.reply,
          ),
      });
    },
    onDeactivated: () => {
      // Revoke capabilities and receipts synchronously BEFORE runtime disposal starts.
      active = undefined;
      host?.deactivate();
      host?.dispose();
      host = undefined;
      receipts.deactivate();
      deactivateTool();
    },
    onStartFailure: ({ ctx }) =>
      notifyAtHostBoundary(ctx, "MCP failed to start for this session.", "warning"),
  });
  const start = (ctx: ExtensionContext): Promise<void> => {
    observeUserIntent();
    const sessionId = mcpCodeModeSessionId(ctx);
    if (sessionId === undefined || sessionId !== previousSessionId) userDeactivated = false;
    previousSessionId = sessionId;
    const captured = captureSessionHost(ctx);
    let conflict: boolean;
    try {
      conflict = visibleTool() !== undefined && !ownsTool();
    } catch {
      conflict = true;
    }
    if (captured._tag === "Unavailable" || conflict) {
      const stopping = slot.shutdown();
      notifyAtHostBoundary(
        ctx,
        conflict
          ? "MCP tool name conflicts with another extension. Its tool was left unchanged."
          : "MCP session context is unavailable.",
        "warning",
      );
      return stopping;
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted: isProjectTrusted(ctx),
          isTrusted: () => isProjectTrusted(ctx),
          sessionId,
          owner: Symbol("mcp.activation"),
        },
        captured.signal,
      )
      .then(() => undefined);
  };
  const shutdown = (): Promise<void> => {
    observeUserIntent();
    return slot.shutdown();
  };
  const commands: McpCommandPort = {
    run: (effect, signal) => slot.run(effect, signal),
    capture: (ctx) => {
      const selected = active;
      const sessionId = mcpCodeModeSessionId(ctx);
      return () =>
        selected !== undefined &&
        selected === active &&
        slot.isCurrent(selected.token) &&
        (selected.input.sessionId === undefined || selected.input.sessionId === sessionId);
    },
  };
  return { start, shutdown, commands, receipts };
};
