// Sole pi-subagents bridge extension loaded into Herdr-hosted Pi children.
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  bestEffortHostBootstrap,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  defineTool,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CompactAnimationScheduler,
  loadCodePreviewSettings,
  withCodePreviewShell,
} from "pi-code-previews";
import { herdrAssignmentEpoch } from "../backend/herdr-assignment.ts";
import {
  isSupervisorMcpMessageArguments,
  isSupervisorMcpReportArguments,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
  SUPERVISOR_MCP_PROXY_TOOL_NAME,
  SUPERVISOR_MCP_TOOL_NAMES,
  type SupervisorMcpReportArguments,
  type SupervisorMcpToolArgumentsByName,
} from "../supervisor/mcp-contract.ts";
import { Type } from "typebox";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { registerSubagentProxyManagerCommand } from "../settings/proxy-controller.ts";
import { decodeSubagentProxyResult, encodeSubagentProxyInput } from "../tools/proxy-protocol.ts";
import { observeAwaitInterruption } from "../tools/execute-await.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { registerSubagentErrorReceipts } from "./host-tool-result.ts";
import {
  createParentCompactSummary,
  createParentExpandedContent,
} from "../tools/compact-parent-summary.ts";
import { parentToolRenderers } from "../tools/render-parent.ts";
import {
  openPiSupervisorBridge,
  type PiSupervisorBridgeClient,
  type PiSupervisorBridgeError,
} from "./pi-supervisor-bridge-client.ts";
import { consumeRuntimeApiCredentials, registerChildPiFastModeHook } from "./host-child-pi.ts";
import { subagentChildRunId } from "./host-environment.ts";

const MessageParameters = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
      pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
    }),
  },
  { additionalProperties: false },
);
const ReportParameters = Type.Object(
  {
    delivery_id: Type.String({
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
      pattern: SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
    }),
    report: Type.String({
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_REPORT_CHARS,
      pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
    }),
  },
  { additionalProperties: false },
);

type SupervisorMcpToolName = keyof SupervisorMcpToolArgumentsByName;
type ReportInput = SupervisorMcpReportArguments;

interface AssignmentReportState {
  readonly generation: number;
  finalText?: string | undefined;
  /** The first possibly delivered identity is immutable for this assignment. */
  deliveryInput?: ReportInput | undefined;
  inFlight?: { readonly input: ReportInput; readonly promise: Promise<string> } | undefined;
  accepted: boolean;
  fallbackStarted: boolean;
  settledSuccessfully: boolean;
}

const sameReportInput = (left: ReportInput, right: ReportInput): boolean =>
  left.delivery_id === right.delivery_id && left.report === right.report;

const finalAssistantText = (event: AgentEndEvent): string | undefined => {
  const message = event.messages.at(-1);
  if (!message || message.role !== "assistant" || message.stopReason !== "stop") return undefined;
  const text = message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n\n")
    .trim();
  return text ? text.slice(0, MAX_SUPERVISOR_MCP_REPORT_CHARS) : undefined;
};

export interface PiSupervisorBridgeExtensionDependencies {
  readonly openBridge: typeof openPiSupervisorBridge;
}

class SupervisorBridge extends Context.Service<SupervisorBridge, PiSupervisorBridgeClient>()(
  "pi-subagents/boundary/host-pi-supervisor-extension/SupervisorBridge",
) {}

import { publishChildQuestionnaireRelay } from "./host-ask-user.ts";

interface SupervisorBridgeSessionInput {
  readonly ctx: ExtensionContext;
  readonly configPath: string;
}

import { registerSubagentMessageRenderers } from "../application/messages.ts";

export default function registerPiSubagentSupervisorBridge(
  pi: ExtensionAPI,
  dependencies: PiSupervisorBridgeExtensionDependencies = { openBridge: openPiSupervisorBridge },
): void {
  registerSubagentMessageRenderers(pi);
  const receipts = registerSubagentErrorReceipts(pi);
  pi.registerFlag("pi-subagents-supervisor-config", {
    description: "Private pi-subagents supervisor channel configuration",
    type: "string",
  });
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI fast-mode request for this subagent",
    type: "boolean",
    default: false,
  });
  let detachRelay: (() => void) | undefined;
  const slot = makePiSessionRuntimeSlot<
    SupervisorBridgeSessionInput,
    SupervisorBridge | CodePreviewSchedulerService,
    never,
    PiSupervisorBridgeError,
    CodePreviewSchedulerServiceContract
  >({
    makeRuntime: ({ configPath }) =>
      makePiManagedRuntime(
        pi,
        Layer.effect(
          SupervisorBridge,
          dependencies.openBridge(configPath, {
            onNotification: (message) =>
              pi.sendMessage(
                { customType: "pi-subagents-proxy-notification", content: message, display: true },
                { deliverAs: "steer", triggerTurn: true },
              ),
          }),
        ).pipe(Layer.merge(CodePreviewSchedulerService.layer)),
      ),
    startup: ({ ctx }) =>
      SupervisorBridge.use(() =>
        bestEffortHostBootstrap("pi-subagents.supervisor-preview-settings", (signal) =>
          loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted(), signal),
        ),
      ).pipe(Effect.andThen(CodePreviewSchedulerService)),
    onActivated: ({ ctx }, token, scheduler) => activateTools(ctx, token, scheduler),
    onDeactivated: () => receipts.deactivate(),
  });
  let started = false;
  let shuttingDown = false;
  let currentToken: number | undefined;
  let assignment: AssignmentReportState = {
    generation: 0,
    accepted: false,
    fallbackStarted: false,
    settledSuccessfully: false,
  };

  const beginAssignment = (prompt: string, requireMarker: boolean): void => {
    const markedEpoch = herdrAssignmentEpoch(prompt);
    if (markedEpoch === undefined && requireMarker) return;
    const generation = markedEpoch ?? assignment.generation + 1;
    if (generation <= assignment.generation) return;
    assignment = {
      generation,
      accepted: false,
      fallbackStarted: false,
      settledSuccessfully: false,
    };
  };

  const callBridge = <Name extends SupervisorMcpToolName>(
    token: number,
    name: Name,
    input: SupervisorMcpToolArgumentsByName[Name],
    signal?: AbortSignal,
    onInterruption?: () => void,
  ): Promise<string> => {
    if (shuttingDown || !slot.isCurrent(token))
      return Promise.reject(new Error("Supervisor bridge is unavailable."));
    return slot
      .run(
        observeAwaitInterruption(
          SupervisorBridge.use((bridge) => bridge.call(name, input)),
          onInterruption,
        ),
        signal,
      )
      .then((text) => {
        if (shuttingDown || !slot.isCurrent(token))
          throw new Error("Supervisor bridge is unavailable.");
        return text;
      });
  };

  const submitReport = (
    token: number,
    state: AssignmentReportState,
    input: ReportInput,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (state.deliveryInput && !sameReportInput(state.deliveryInput, input))
      return Promise.reject(
        new Error("This assignment already attempted a different supervisor report identity."),
      );
    if (state.accepted) return Promise.resolve("Supervisor report already accepted.");
    if (state.inFlight) return state.inFlight.promise;
    if (shuttingDown || !slot.isCurrent(token))
      return Promise.reject(new Error("Supervisor bridge is unavailable."));
    state.deliveryInput = input;
    const promise = callBridge(token, SUPERVISOR_MCP_TOOL_NAMES[3], input, signal).then((text) => {
      state.accepted = true;
      return text;
    });
    state.inFlight = { input, promise };
    const clearInFlight = () => {
      if (state.inFlight?.promise === promise) state.inFlight = undefined;
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  };

  const activateTools = (
    ctx: ExtensionContext,
    token: number,
    scheduler: CodePreviewSchedulerServiceContract,
  ): void => {
    currentToken = token;
    if (shuttingDown || !slot.isCurrent(token)) return;
    const scheduleAnimation: CompactAnimationScheduler = (interval, tick) =>
      !shuttingDown && slot.isCurrent(token) ? scheduler.schedule(interval, tick) : undefined;

    const messageTool = (
      name: (typeof SUPERVISOR_MCP_MESSAGE_TOOL_NAMES)[number],
      label: string,
      description: string,
    ) =>
      defineTool({
        name,
        label,
        description,
        parameters: MessageParameters,
        execute(_id, input, signal) {
          if (!isSupervisorMcpMessageArguments(input))
            return Promise.reject(new Error("Supervisor message input is malformed or excessive."));
          return callBridge(token, name, { message: input.message }, signal).then((text) => ({
            content: [{ type: "text" as const, text }],
            details: {},
          }));
        },
      });

    const report = defineTool({
      name: SUPERVISOR_MCP_TOOL_NAMES[3],
      label: "Submit Supervisor Report",
      description:
        "Submit one complete final report for the current assignment with a fresh stable delivery identity. This is the only completion signal.",
      promptSnippet: "Submit the complete final report to the parent supervisor",
      promptGuidelines: [
        `Call ${SUPERVISOR_MCP_TOOL_NAMES[3]} exactly once after completing the assignment. Use a fresh bounded delivery_id for each later retained assignment.`,
      ],
      parameters: ReportParameters,
      execute(_id, input, signal) {
        if (!isSupervisorMcpReportArguments(input))
          return Promise.reject(new Error("Supervisor report input is malformed or excessive."));
        return submitReport(token, assignment, input, signal).then((text) => ({
          content: [{ type: "text" as const, text }],
          details: {},
        }));
      },
    });

    const proxyCall = (
      input: import("../tools/schema.ts").SubagentToolInput,
      signal?: AbortSignal,
      onInterruption?: () => void,
    ) => {
      const encoded = encodeSubagentProxyInput(input);
      return callBridge(
        token,
        SUPERVISOR_MCP_PROXY_TOOL_NAME,
        { tool: encoded.tool, arguments_json: encoded.argumentsJson },
        signal,
        onInterruption,
      ).then((source) => {
        const result = decodeSubagentProxyResult(source);
        if (!result) throw new Error("Root coordinator returned an invalid response.");
        return result;
      });
    };
    try {
      detachRelay = publishChildQuestionnaireRelay(
        pi.events,
        ctx.sessionManager.getSessionId(),
        () => !shuttingDown && slot.isCurrent(token),
        (request, signal) =>
          callBridge(
            token,
            SUPERVISOR_MCP_PROXY_TOOL_NAME,
            { tool: request.tool, arguments_json: request.argumentsJson },
            signal,
          ).then((source) => {
            const result = decodeSubagentProxyResult(source);
            if (!result)
              throw new Error("Root coordinator returned an invalid questionnaire response.");
            return result;
          }),
      );
    } catch {
      /* Missing session discovery disables only the optional questionnaire relay. */
    }
    registerSubagentTools(
      pi,
      {
        scheduleAnimation,
        environment: { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() },
        proxyCall,
        run: () => Promise.reject(new Error("Delegated Pi uses the root coordinator proxy.")),
      },
      { receipts, owner: receipts.activate() },
    );
    const runId = subagentChildRunId();
    if (runId) registerSubagentProxyManagerCommand(pi, runId, proxyCall);

    const tools = [
      messageTool(
        SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[0],
        "Supervisor Progress",
        "Send bounded progress to the parent projection without blocking.",
      ),
      messageTool(
        SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[1],
        "Supervisor Warning",
        "Record a bounded non-blocking warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
      ),
      messageTool(
        SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2],
        "Ask Supervisor",
        "Ask this assignment's one exact correlated blocking parent question and wait for its reply.",
      ),
      report,
    ];
    for (const tool of tools)
      pi.registerTool(
        withCodePreviewShell(
          { ...tool, ...parentToolRenderers(tool.name, tool.label) },
          {
            scheduleAnimation,
            compactSummary: createParentCompactSummary(tool.name),
            expandedContent: createParentExpandedContent(tool.name),
          },
        ),
      );
    pi.setActiveTools([
      ...new Set([
        ...pi
          .getActiveTools()
          .filter(
            (name) =>
              !name.startsWith("subagent_") &&
              !name.startsWith("herdr_agent_") &&
              name !== "contact_parent",
          ),
        ...tools.map((tool) => tool.name),
        ...SUBAGENT_TOOL_NAMES,
      ]),
    ]);
  };

  registerChildPiFastModeHook(pi, () => pi.getFlag("pi-subagents-fast-mode") === true);

  pi.on("session_start", (_event, ctx) => {
    if (started) return;
    started = true;
    shuttingDown = false;
    // Ephemeral provider bootstrap must be consumed before any early return so a malformed private
    // bridge flag cannot leave credentials in the long-lived delegated Pi environment.
    const runtimeApi = consumeRuntimeApiCredentials(process.env);

    const config = pi.getFlag("pi-subagents-supervisor-config");
    if (!Predicate.isString(config)) {
      if (ctx.hasUI)
        notifyAtHostBoundary(
          ctx,
          "Subagent supervisor couldn't start: configuration is missing",
          "error",
        );
      return;
    }
    if (runtimeApi.apiKey && runtimeApi.provider)
      pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });

    return slot.start({ configPath: config, ctx }).then((token) => {
      if (token === undefined || shuttingDown || !slot.isCurrent(token)) {
        if (!shuttingDown && ctx.hasUI)
          notifyAtHostBoundary(ctx, "Subagent supervisor couldn't connect to its parent", "error");
        return;
      }
    });
  });

  // Herdr can steer a retained assignment into a still-running Pi loop. `input` observes that
  // fixed epoch marker even when Pi consequently emits no second `before_agent_start` event.
  pi.on("input", (event) => {
    beginAssignment(event.text, true);
  });

  pi.on("before_agent_start", (event) => {
    beginAssignment(event.prompt, false);
  });

  pi.on("agent_end", (event) => {
    const text = finalAssistantText(event);
    assignment.finalText = text;
    assignment.settledSuccessfully = text !== undefined;
  });

  pi.on("agent_settled", () => {
    const state = assignment;
    if (shuttingDown || state.accepted || state.fallbackStarted || !state.settledSuccessfully)
      return;
    const input =
      state.deliveryInput ??
      (state.finalText
        ? {
            delivery_id: `pi-final-${state.generation}`,
            report: state.finalText,
          }
        : undefined);
    if (!input) return;
    const token = currentToken;
    if (token === undefined || !slot.isCurrent(token)) return;
    state.fallbackStarted = true;
    return submitReport(token, state, input).then(
      () => undefined,
      () => undefined,
    );
  });

  pi.on("session_shutdown", () => {
    receipts.deactivate();
    shuttingDown = true;
    detachRelay?.();
    detachRelay = undefined;
    currentToken = undefined;
    return slot.shutdown();
  });
}
