import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalControls } from "pi-cosmic-core";
import type { HerdrAgentView } from "../herd/model.ts";

const clean = (value: string): string =>
  stripTerminalControls(value).replaceAll(/\s+/g, " ").trim();

export const formatHerdrAgent = (agent: HerdrAgentView): string => {
  const report = agent.report ? " · report ready" : "";
  return `${clean(agent.id)} ${clean(agent.name)} · ${agent.state}${report} · ${clean(agent.session)} · ${clean(agent.workspaceId)}/${clean(agent.tabId)}`;
};

export const formatHerdrAgents = (agents: ReadonlyArray<HerdrAgentView>): string =>
  agents.length > 0 ? agents.map(formatHerdrAgent).join("\n") : "No managed Herdr agents.";

export const formatHerdrReports = (agents: ReadonlyArray<HerdrAgentView>): string => {
  const sections = agents.map((agent) => {
    const header = `## ${clean(agent.name)} (${agent.state})`;
    const body = agent.report ?? agent.error ?? "No final report is available.";
    return `${header}\n\n${body}`;
  });
  return truncateHead(sections.join("\n\n"), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  }).content;
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
