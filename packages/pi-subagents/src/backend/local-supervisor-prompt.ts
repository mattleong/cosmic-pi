import type { BackendLaunchRequest } from "./model.ts";

/** Fixed local-CLI bridge instructions; no profile can alter the supervisor/report contract. */
export const withLocalSupervisorInstructions = (
  request: BackendLaunchRequest,
): BackendLaunchRequest => ({
  ...request,
  systemPrompt: [
    request.systemPrompt,
    "For this local CLI harness, use only the pi_subagents_supervisor MCP tools for parent communication: supervisor_progress, supervisor_warning, supervisor_question, and supervisor_submit_report. The contact_parent name in generic instructions refers to these tools.",
    "A supervisor_submit_report call is the only completion signal. Submit one concise final report with a fresh bounded deliveryId after the assignment is complete. Raw final assistant text does not complete the run.",
    "Never launch, delegate to, or coordinate another agent. Do not use integrations, plugins, apps, hooks, skills, browser automation, remote control, or MCP servers other than pi_subagents_supervisor.",
    request.writeIntent === "read-only"
      ? "Read-only is a fixed tool capability policy for Claude Code and a native read-only sandbox for Codex. Do not run shell commands or mutate any file."
      : "Writer intent permits project edits within the assigned cwd only; keep changes narrowly within the assignment.",
  ].join("\n\n"),
});
