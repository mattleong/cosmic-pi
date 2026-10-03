import { canonicalResultJson, resultValueSchema } from "../domain/result-contract.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import type { BackendLaunchRequest } from "./model.ts";

const REPORT_TOOL = SUPERVISOR_MCP_TOOL_NAMES[3];

/** Fixed local-CLI bridge instructions; no profile can alter the supervisor/report contract. */
export const withLocalSupervisorInstructions = (
  request: BackendLaunchRequest,
): BackendLaunchRequest => ({
  ...request,
  systemPrompt: [
    request.systemPrompt,
    `For this local CLI harness, use only the ${SUPERVISOR_MCP_REGISTRATION} MCP tools for parent communication: ${SUPERVISOR_MCP_TOOL_NAMES.join(", ")}. The contact_parent name in generic instructions refers to these tools.`,
    `A ${REPORT_TOOL} call is the only completion signal. Submit one concise final report with a fresh bounded delivery_id after the assignment is complete. Raw final assistant text does not complete the run.`,
    ...(request.resultContract
      ? [
          `The ${REPORT_TOOL} report must be exactly one JSON value, with no prose or code fences, matching this JSON Schema:\n${canonicalResultJson(resultValueSchema(request.resultContract))}\nIt is your return value to a program. A rejected report lists the problems; fix them and submit again.`,
        ]
      : []),
    `Never launch, delegate to, or coordinate another agent. Do not use integrations, plugins, apps, hooks, skills, browser automation, remote control, or MCP servers other than ${SUPERVISOR_MCP_REGISTRATION}.`,
    request.writeIntent === "read-only"
      ? "Read-only Bash is available for inspection and validation inside the runtime's strict filesystem sandbox. Do not attempt to mutate project files or bypass the sandbox; use a writer assignment for intentional project changes."
      : "Writer intent permits project edits within the assigned cwd only; keep changes narrowly within the assignment.",
  ].join("\n\n"),
});
