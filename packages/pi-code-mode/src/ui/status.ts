import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  renderCompactIssues,
  renderExpandedAttention,
  summaryCompactIssues,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { decodeOption } from "../tools/format.ts";
import { CodeModeStatusSchema, codeModeStatusFits, type CodeModeStatus } from "../tools/status.ts";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import { codeModeOutputText } from "./result-output.ts";

const StatusRequestSchema = Schema.Struct({ action: Schema.Literal("status") });
const StatusDetailsSchema = Schema.Struct({
  status: CodeModeStatusSchema,
  cancelled: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
});
const TextContentSchema = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

type SummaryProvider = CompactSummaryProvider<unknown, unknown, unknown>;

/** Request identity chooses the status view. Producer details still determine its outcome. */
export const codeModeStatusRequest = <Args>(args: Args): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(StatusRequestSchema, { onExcessProperty: "error" })(args),
  );

/** Status presentation trusts only independently decoded producer metadata, never result text. */
export const decodeCodeModeStatus = <Details>(details: Details): CodeModeStatus | undefined =>
  decodeOption(StatusDetailsSchema, details)?.status;

export const codeModeStatusCompactSummary = ({
  phase,
  result,
  context,
}: Parameters<SummaryProvider>[0]): ReturnType<SummaryProvider> => {
  const heading = {
    action: "status",
    subject: "Effective limits",
    compactSubject: "Limits",
  } as const;
  if (result === undefined || phase !== "settled") return phase === "settled" ? undefined : heading;
  const details = decodeOption(StatusDetailsSchema, result.details);
  const status = details?.status;
  if (status === undefined) return undefined;
  let isError: boolean;
  try {
    isError = context.isError === true;
  } catch {
    return undefined;
  }
  if (isError)
    return {
      ...heading,
      outcome: "error",
      detailsOnExpand: true,
    };
  if (details?.cancelled || details?.truncated)
    return {
      ...heading,
      outcome: details.cancelled ? "cancelled" : "warning",
      detailsOnExpand: true,
      issues: {
        coverage: "complete",
        entries: [
          {
            operation: "status",
            code: details.cancelled ? "status-cancelled" : "status-truncated",
            severity: "warning",
            cause: details.cancelled
              ? "The status response was cancelled."
              : "The status response was truncated.",
            description: details.cancelled
              ? "The status response was cancelled."
              : "Only part of the status response was returned.",
            recovery: [],
          },
        ],
      },
    };
  if (codeModeStatusFits(status))
    return {
      ...heading,
      counters: ["5 limits"],
      outcome: "success",
      detailsOnExpand: true,
    };
  return {
    ...heading,
    outcome: "warning",
    detailsOnExpand: true,
    issues: {
      coverage: "complete",
      entries: [
        {
          operation: "status",
          code: "output-budget",
          severity: "warning",
          cause: "The output limit cannot fit the complete status JSON.",
          description: "The configured output limit is too small to return status.",
          recovery: [],
          diagnostics: ["No program or nested tool was run."],
        },
      ],
    },
  };
};

export const renderCodeModeStatusCall = (theme: Theme): Component => {
  let header = "Code Mode status · Effective limits";
  try {
    header = renderToolHeader({ title: "Code Mode status", subtitle: "· Effective limits" }, theme);
  } catch {
    // Plain text keeps the status call visible under a hostile theme.
  }
  return new Text(header, 0, 0);
};

export const renderCodeModeStatusCallContent = (): Component => new Container();

const rawText = (result: AgentToolResult<unknown>): string =>
  (decodeOption(TextContentSchema, result.content) ?? []).map((part) => part.text).join("\n");

export const renderCodeModeStatusResult = (
  result: AgentToolResult<unknown>,
  options: Pick<ToolRenderResultOptions, "isPartial">,
  theme: Theme,
  context: { readonly expanded?: boolean; readonly isError?: boolean } | undefined,
  summary: CompactSummary | undefined,
  contentOnly = false,
): Component => {
  let isPartial = false;
  let expanded = false;
  let isError = false;
  try {
    isPartial = options.isPartial === true;
    expanded = context?.expanded === true;
    isError = context?.isError === true;
  } catch {
    // Hostile render state falls back to a conservative settled-unknown view.
  }
  const lines: Array<{ readonly text: string; readonly color: "muted" | "error" | "toolOutput" }> =
    [];
  if (!contentOnly || summary === undefined) {
    lines.push({
      text: isPartial
        ? "Reading effective limits"
        : isError || summary?.outcome === "error"
          ? "Status failed"
          : summary?.outcome === "success"
            ? "Effective limits loaded"
            : summary?.outcome === "warning"
              ? "Status refused by output limit"
              : "Status outcome unavailable",
      color: isError || summary?.outcome === "error" ? "error" : "muted",
    });
  }
  let raw = "";
  try {
    raw = rawText(result);
  } catch {
    // Hostile result content cannot establish status or suppress other presentation.
  }
  if (expanded && !isPartial && raw.length > 0) {
    lines.push(
      { text: "Raw output", color: "muted" },
      { text: codeModeOutputText(raw), color: "toolOutput" },
    );
  }
  const issues = summary && !contentOnly ? summaryCompactIssues(summary, expanded) : undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      const body = new Text(
        lines
          .map(({ text, color }) => {
            const safe = codeModeOutputText(text);
            try {
              return theme.fg(color, safe);
            } catch {
              return safe;
            }
          })
          .join("\n"),
        0,
        0,
      ).render(Math.floor(width));
      if (!issues) return body;
      try {
        const attention = expanded
          ? renderExpandedAttention(issues, [], theme, width)
          : renderCompactIssues(issues, theme, width);
        return [...attention, ...body];
      } catch {
        return body;
      }
    },
    invalidate() {},
  };
};
