// Sole pi-subagents bridge extension loaded into Herdr-hosted Pi children.
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  hasObjectRuntimeType,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { defineTool, type AgentEndEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { herdrAssignmentEpoch } from "../backend/herdr-assignment.ts";
import { Type } from "typebox";
import {
  openPiSupervisorBridge,
  type PiSupervisorBridgeClient,
} from "./pi-supervisor-bridge-client.ts";
import type { RpcSessionError } from "./rpc-session.ts";

const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_REPORT_CHARS = 32 * 1024;
const DELIVERY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";

const MessageParameters = Type.Object(
  { message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS, pattern: ".*\\S.*" }) },
  { additionalProperties: false },
);
const ReportParameters = Type.Object(
  {
    delivery_id: Type.String({ minLength: 1, maxLength: 256, pattern: DELIVERY_PATTERN }),
    report: Type.String({ minLength: 1, maxLength: MAX_REPORT_CHARS, pattern: ".*\\S.*" }),
  },
  { additionalProperties: false },
);

const exactMessage = <InputInput>(
  input: InputInput,
): input is InputInput & { readonly message: string } =>
  Boolean(
    input &&
    hasObjectRuntimeType(input) &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    "message" in input &&
    Predicate.isString(input.message) &&
    input.message.trim() &&
    input.message.length <= MAX_MESSAGE_CHARS,
  );
const exactReport = <InputInput>(
  input: InputInput,
): input is InputInput & { readonly delivery_id: string; readonly report: string } =>
  Boolean(
    input &&
    hasObjectRuntimeType(input) &&
    !Array.isArray(input) &&
    Object.keys(input).length === 2 &&
    "delivery_id" in input &&
    Predicate.isString(input.delivery_id) &&
    new RegExp(DELIVERY_PATTERN).test(input.delivery_id) &&
    "report" in input &&
    Predicate.isString(input.report) &&
    input.report.trim() &&
    input.report.length <= MAX_REPORT_CHARS,
  );

type ReportInput = { readonly delivery_id: string; readonly report: string };

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
  return text ? text.slice(0, MAX_REPORT_CHARS) : undefined;
};

export interface PiSupervisorBridgeExtensionDependencies {
  readonly openBridge: typeof openPiSupervisorBridge;
}

class SupervisorBridge extends Context.Service<SupervisorBridge, PiSupervisorBridgeClient>()(
  "pi-subagents/boundary/host-pi-supervisor-extension/SupervisorBridge",
) {}

interface SupervisorBridgeSessionInput {
  readonly configPath: string;
}

/** Reads and scrubs the one-shot runtime API credentials from the given environment snapshot. */
const consumeRuntimeApiCredentials = (environment: NodeJS.ProcessEnv) => {
  const apiKey = environment.PI_SUBAGENT_RUNTIME_API_KEY;
  const provider = environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  delete environment.PI_SUBAGENT_RUNTIME_API_KEY;
  delete environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  return { apiKey, provider };
};

export default function registerPiSubagentSupervisorBridge(
  pi: ExtensionAPI,
  dependencies: PiSupervisorBridgeExtensionDependencies = { openBridge: openPiSupervisorBridge },
): void {
  pi.registerFlag("pi-subagents-supervisor-config", {
    description: "Private pi-subagents supervisor channel configuration",
    type: "string",
  });
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI fast-mode request for this subagent",
    type: "boolean",
    default: false,
  });
  const fastMode = pi.getFlag("pi-subagents-fast-mode") === true;
  let client: PiSupervisorBridgeClient | undefined;
  const slot = makePiSessionRuntimeSlot<
    SupervisorBridgeSessionInput,
    SupervisorBridge,
    never,
    RpcSessionError,
    PiSupervisorBridgeClient
  >({
    makeRuntime: ({ configPath }) =>
      makePiManagedRuntime(pi, Layer.effect(SupervisorBridge, dependencies.openBridge(configPath))),
    startup: () => SupervisorBridge.use((bridge) => Effect.succeed(bridge)),
    onActivated: (_input, _token, bridge) => {
      client = bridge;
    },
    onDeactivated: () => {
      client = undefined;
    },
  });
  let started = false;
  let shuttingDown = false;
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

  const submitReport = (
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
    const bridge = client;
    if (!bridge || shuttingDown)
      return Promise.reject(new Error("Supervisor bridge is unavailable."));
    state.deliveryInput = input;
    const promise = bridge.call("supervisor_submit_report", input, signal).then((text) => {
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

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !fastMode ||
      !ctx.model ||
      !supportsFastModel(ctx.model.provider, ctx.model.id) ||
      !event.payload ||
      !hasObjectRuntimeType(event.payload) ||
      Array.isArray(event.payload)
    )
      return undefined;
    return { ...event.payload, service_tier: FAST_SERVICE_TIER };
  });

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
        ctx.ui.notify("Private subagent supervisor configuration is missing.", "error");
      return;
    }
    if (runtimeApi.apiKey && runtimeApi.provider)
      pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });

    return slot.start({ configPath: config }).then((token) => {
      if (token === undefined || shuttingDown || !slot.isCurrent(token)) {
        if (!shuttingDown && ctx.hasUI)
          ctx.ui.notify("Unable to open the private subagent supervisor bridge.", "error");
        return;
      }
      return loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())
        .catch(() => undefined)
        .then(() => {
          if (shuttingDown || !slot.isCurrent(token) || !client) return;

          const messageTool = (
            name: "supervisor_progress" | "supervisor_warning" | "supervisor_question",
            label: string,
            description: string,
          ) =>
            defineTool({
              name,
              label,
              description,
              parameters: MessageParameters,
              execute(_id, input, signal) {
                if (!exactMessage(input))
                  return Promise.reject(
                    new Error("Supervisor message input is malformed or excessive."),
                  );
                return Promise.resolve(client?.call(name, { message: input.message }, signal)).then(
                  (text) => ({
                    content: [{ type: "text" as const, text: text ?? "Supervisor unavailable." }],
                    details: {},
                  }),
                );
              },
            });

          const report = defineTool({
            name: "supervisor_submit_report",
            label: "Submit Supervisor Report",
            description:
              "Submit one complete final report for the current assignment with a fresh stable delivery identity. This is the only completion signal.",
            promptSnippet: "Submit the complete final report to the parent supervisor",
            promptGuidelines: [
              "Call supervisor_submit_report exactly once after completing the assignment. Use a fresh bounded delivery_id for each later retained assignment.",
            ],
            parameters: ReportParameters,
            execute(_id, input, signal) {
              if (!exactReport(input))
                return Promise.reject(
                  new Error("Supervisor report input is malformed or excessive."),
                );
              return submitReport(assignment, input, signal).then((text) => ({
                content: [{ type: "text" as const, text }],
                details: {},
              }));
            },
          });

          const tools = [
            messageTool(
              "supervisor_progress",
              "Supervisor Progress",
              "Send bounded progress to the parent projection without blocking.",
            ),
            messageTool(
              "supervisor_warning",
              "Supervisor Warning",
              "Record a bounded non-blocking warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
            ),
            messageTool(
              "supervisor_question",
              "Ask Supervisor",
              "Ask this assignment's one exact correlated blocking parent question and wait for its reply.",
            ),
            report,
          ];
          for (const tool of tools) pi.registerTool(withCodePreviewShell(tool));
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
            ]),
          ]);
        });
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
    state.fallbackStarted = true;
    return submitReport(state, input).then(
      () => undefined,
      () => undefined,
    );
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    client = undefined;
    return slot.shutdown();
  });
}
