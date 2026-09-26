import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { decodeOption } from "../tools/format.ts";
import { CodeModeStatusSchema, codeModeStatusFits, type CodeModeStatus } from "../tools/status.ts";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import { renderPlainResultView } from "./result-read-renderer.ts";

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
  if (isError) return { ...heading, outcome: "error" };
  if (details?.cancelled || details?.truncated)
    return {
      ...heading,
      outcome: details.cancelled ? "cancelled" : "warning",
      issues: [
        details.cancelled
          ? {
              severity: "warning",
              code: "status-cancelled",
              message: "The status response was cancelled",
            }
          : {
              severity: "warning",
              code: "status-truncated",
              message: "Only part of the status response was returned",
            },
      ],
    };
  if (codeModeStatusFits(status)) return { ...heading, counters: ["5 limits"], outcome: "success" };
  return {
    ...heading,
    outcome: "warning",
    issues: [
      {
        severity: "warning",
        code: "output-budget",
        message: "The configured output limit is too small to return status",
        detail:
          "The output limit cannot fit the complete status JSON. No program or nested tool was run.",
      },
    ],
  };
};

export const renderCodeModeStatusCall = (theme: Theme): Component => {
  const header = invokeHostCallback(
    () => renderToolHeader({ title: "Code Mode status", subtitle: "· Effective limits" }, theme),
    "Code Mode status · Effective limits",
  );
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
  const failed = isError || summary?.outcome === "error";
  const status = isPartial
    ? "Reading effective limits"
    : failed
      ? "Status failed"
      : summary?.outcome === "success"
        ? "Effective limits loaded"
        : summary?.outcome === "warning"
          ? "Status refused by output limit"
          : "Status outcome unavailable";
  // Hostile result content cannot establish status or suppress other presentation.
  const raw = invokeHostCallback(() => rawText(result), "");
  const view = { isPartial, failed, expanded, contentOnly };
  return renderPlainResultView(status, raw, summary, view, theme);
};
