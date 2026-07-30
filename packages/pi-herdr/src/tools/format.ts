import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import { stripTerminalControls } from "pi-cosmic-core";
import type { HerdrAgentView, HerdrBatchFailure } from "../herd/model.ts";
import { isHerdrAgentFinished } from "../herd/model.ts";
import { formatHerdrState } from "../herd/projection.ts";

const REPORT_SECTION_OVERHEAD_BYTES = 512;
const REPORT_TRUNCATION_MARKER = "\n… [report truncated; await this run ID individually for more]";
const encoder = new TextEncoder();

const clean = (value: string): string =>
  stripTerminalControls(value).replaceAll(/\s+/g, " ").trim();

const cleanBody = (value: string): string => stripTerminalControls(value).trim();

const clip = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;

const utf8Prefix = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const nextBytes = encoder.encode(character).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    output += character;
    bytes += nextBytes;
  }
  return output;
};

const boundReportBody = (
  value: string,
  maxBytes: number,
  maxLines: number,
): { readonly text: string; readonly truncated: boolean } => {
  const lines = value.split("\n");
  const lineBounded = lines.slice(0, maxLines).join("\n");
  const markerBytes = encoder.encode(REPORT_TRUNCATION_MARKER).byteLength;
  const byteBounded = utf8Prefix(lineBounded, Math.max(0, maxBytes - markerBytes));
  const truncated = lines.length > maxLines || byteBounded !== lineBounded;
  return {
    text: truncated ? `${byteBounded}${REPORT_TRUNCATION_MARKER}` : byteBounded,
    truncated,
  };
};

export const formatHerdrAgent = (agent: HerdrAgentView): string => {
  const report = agent.report ? " · report ready" : "";
  const attention = agent.error ? " · attention" : "";
  const model = agent.model ? ` · ${clean(agent.model)}` : "";
  return `${clean(agent.id)} [${agent.kind}] ${clean(agent.name)} · ${formatHerdrState(agent.state)}${report}${attention}${model}`;
};

export const formatHerdrAgents = (agents: ReadonlyArray<HerdrAgentView>): string =>
  agents.length > 0 ? agents.map(formatHerdrAgent).join("\n") : "No managed Herdr agents.";

export const formatHerdrAgentList = (
  agents: ReadonlyArray<HerdrAgentView>,
  limit = 25,
  offset = 0,
): string => {
  if (agents.length === 0) return "No managed Herdr agents.";
  const running = agents.filter(
    (agent) => !isHerdrAgentFinished(agent.state) && agent.state !== "blocked",
  ).length;
  const blocked = agents.filter((agent) => agent.state === "blocked").length;
  const finished = agents.filter((agent) => isHerdrAgentFinished(agent.state)).length;
  const start = Math.min(Math.max(0, offset), agents.length);
  const visible = agents.slice(start, start + limit);
  const end = start + visible.length;
  const remaining = agents.length - end;
  const summary = `Herdr agents: ${running} running · ${blocked} blocked · ${finished} finished · showing ${visible.length === 0 ? 0 : start + 1}–${end} of ${agents.length}`;
  const pagination =
    remaining > 0
      ? `\n… ${remaining} more run${remaining === 1 ? "" : "s"}; call herdr_agent_list with offset=${end}.`
      : "";
  const rows =
    visible.length > 0
      ? visible.map(formatHerdrAgent).join("\n")
      : `No rows at offset ${offset}; reset offset to 0.`;
  return `${summary}\n${rows}${pagination}`;
};

export const formatHerdrAgentDetails = (agent: HerdrAgentView): string => {
  const field = (name: string, value: string): string => `  ${name.padEnd(10)} ${clean(value)}`;
  return [
    "Herdr agent status",
    field("Name", agent.name),
    field("ID", agent.id),
    field("Kind", agent.kind),
    agent.model ? field("Model", agent.model) : undefined,
    field("State", formatHerdrState(agent.state)),
    agent.remoteStatus ? field("Remote", agent.remoteStatus) : undefined,
    field("Task", clip(clean(agent.task), 320)),
    field("Report", agent.report ? "ready" : "not available"),
    agent.error ? field("Attention", clip(agent.error, 640)) : undefined,
    field("Session", agent.session),
    field("Location", `${agent.workspaceId}/${agent.tabId}/${agent.paneId}`),
    field("Started", DateTime.formatIso(DateTime.makeUnsafe(agent.startedAt))),
    field("Updated", DateTime.formatIso(DateTime.makeUnsafe(agent.updatedAt))),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

const reportRecovery = (agent: HerdrAgentView): string => {
  if (agent.state === "blocked" && agent.report !== undefined)
    return `This blocked report is final. Stop ${agent.id} when inspection is complete, or start a new agent for follow-up work.`;
  if (agent.state === "blocked")
    return `This agent needs attention. Inspect it with herdr_agent_read, send guidance with herdr_agent_send, then await it again.`;
  if (agent.state === "failed" && agent.report === undefined)
    return `No durable report was received. Inspect it with herdr_agent_read or close it with herdr_agent_stop.`;
  return "";
};

export const formatHerdrReports = (agents: ReadonlyArray<HerdrAgentView>): string => {
  if (agents.length === 0) return "No managed Herdr agent reports.";
  const perReportBytes = Math.max(
    256,
    Math.floor(DEFAULT_MAX_BYTES / agents.length) - REPORT_SECTION_OVERHEAD_BYTES,
  );
  const perReportLines = Math.max(4, Math.floor(DEFAULT_MAX_LINES / agents.length) - 6);
  return agents
    .map((agent) => {
      const header = `## ${clean(agent.name)} [${agent.kind}] (${formatHerdrState(agent.state)}) · ${clean(agent.id)}`;
      const body = cleanBody(agent.report ?? agent.error ?? "No final report is available.");
      const recovery = reportRecovery(agent);
      const recoveryBlock = recovery ? `\n\nNext: ${recovery}` : "";
      const bounded = boundReportBody(
        body,
        Math.max(256, perReportBytes - encoder.encode(recoveryBlock).byteLength),
        Math.max(1, perReportLines - (recovery ? 2 : 0)),
      );
      return `${header}\n\n${bounded.text}${recoveryBlock}`;
    })
    .join("\n\n");
};

export const formatHerdrTerminalRead = (
  runId: string,
  source: string,
  lines: number,
  text: string,
): string => {
  const bounded = truncateTail(stripTerminalControls(text), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const body = bounded.content || "(no terminal output)";
  const marker = bounded.truncated ? "… [older terminal output truncated]\n" : "";
  return `Herdr terminal output · ${clean(runId)} · ${clean(source)} · up to ${lines} lines\n\n${marker}${body}`;
};

export const formatHerdrFailures = (failures: ReadonlyArray<HerdrBatchFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed targets (${failures.length})`,
        ...failures.map(
          (failure) =>
            `  ${clean(failure.id)} [${clean(failure.code)}]: ${clip(clean(failure.message), 640)}`,
        ),
      ].join("\n");

export const withHerdrFailures = (
  content: string,
  failures: ReadonlyArray<HerdrBatchFailure>,
): string => {
  const failureText = formatHerdrFailures(failures);
  if (!failureText) return content;
  return !content || content === "No managed Herdr agents."
    ? failureText
    : `${content}\n\n${failureText}`;
};

export const formatFailure = (
  error: unknown,
): { readonly code: string; readonly message: string } => {
  if (typeof error === "object" && error !== null) {
    const value = error as {
      readonly _tag?: unknown;
      readonly code?: unknown;
      readonly message?: unknown;
    };
    return {
      code:
        typeof value.code === "string"
          ? value.code
          : typeof value._tag === "string"
            ? value._tag
            : "herdr_operation_failed",
      message: typeof value.message === "string" ? clean(value.message) : "Herdr operation failed.",
    };
  }
  return { code: "herdr_operation_failed", message: "Herdr operation failed." };
};
