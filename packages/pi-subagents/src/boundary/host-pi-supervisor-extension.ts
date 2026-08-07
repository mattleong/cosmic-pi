// Sole pi-subagents bridge extension loaded into Herdr-hosted Pi children.
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { Type } from "typebox";
import {
  openPiSupervisorBridge,
  type PiSupervisorBridgeClient,
} from "./pi-supervisor-bridge-client.ts";

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

const exactMessage = (input: unknown): input is { readonly message: string } =>
  Boolean(
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    "message" in input &&
    typeof input.message === "string" &&
    input.message.trim() &&
    input.message.length <= MAX_MESSAGE_CHARS,
  );
const exactReport = (
  input: unknown,
): input is { readonly delivery_id: string; readonly report: string } =>
  Boolean(
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === 2 &&
    "delivery_id" in input &&
    typeof input.delivery_id === "string" &&
    new RegExp(DELIVERY_PATTERN).test(input.delivery_id) &&
    "report" in input &&
    typeof input.report === "string" &&
    input.report.trim() &&
    input.report.length <= MAX_REPORT_CHARS,
  );

export default function registerPiSubagentSupervisorBridge(pi: ExtensionAPI): void {
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
  let started = false;

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !fastMode ||
      !ctx.model ||
      !supportsFastModel(ctx.model.provider, ctx.model.id) ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      return undefined;
    return { ...event.payload, service_tier: FAST_SERVICE_TIER };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (started) return;
    started = true;
    // Ephemeral provider bootstrap must be consumed before any early return so a malformed private
    // bridge flag cannot leave credentials in the long-lived delegated Pi environment.
    const runtimeApiKey = process.env.PI_SUBAGENT_RUNTIME_API_KEY;
    const runtimeApiProvider = process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;
    delete process.env.PI_SUBAGENT_RUNTIME_API_KEY;
    delete process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;

    const config = pi.getFlag("pi-subagents-supervisor-config");
    if (typeof config !== "string") {
      if (ctx.hasUI)
        ctx.ui.notify("Private subagent supervisor configuration is missing.", "error");
      return;
    }
    if (runtimeApiKey && runtimeApiProvider)
      pi.registerProvider(runtimeApiProvider, { apiKey: runtimeApiKey });

    try {
      client = await openPiSupervisorBridge(config);
      await loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted()).catch(() => undefined);
    } catch {
      if (ctx.hasUI)
        ctx.ui.notify("Unable to open the private subagent supervisor bridge.", "error");
      return;
    }

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
        async execute(_id, input, signal) {
          if (!exactMessage(input))
            throw new Error("Supervisor message input is malformed or excessive.");
          const text = await client?.call(name, { message: input.message }, signal);
          return {
            content: [{ type: "text" as const, text: text ?? "Supervisor unavailable." }],
            details: {},
          };
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
      async execute(_id, input, signal) {
        if (!exactReport(input))
          throw new Error("Supervisor report input is malformed or excessive.");
        const text = await client?.call("supervisor_submit_report", input, signal);
        return {
          content: [{ type: "text" as const, text: text ?? "Supervisor unavailable." }],
          details: {},
        };
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

  pi.on("session_shutdown", () => {
    client?.close();
    client = undefined;
  });
}
