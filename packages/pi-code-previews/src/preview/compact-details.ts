import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { escapeControlChars } from "../shared/terminal-text";
import { summaryCompactIssues } from "../tools/compact-issues";
import { planCompactPresentation } from "../tools/compact-presentation";
import type { CompactPhase, CompactSummary } from "../tools/compact-summary";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { renderExpandedAttention } from "./compact-issues";
import { renderCompactRow } from "./compact-row";
import { CompactSlots, type CompactRenderBody, type CompactSlot } from "./compact-slots";

export function composeCompactDetails(input: {
  name: string;
  context: ToolRenderContext<any, any>;
  theme: Theme;
  summary: CompactSummary | undefined;
  phase: CompactPhase;
  plan: ReturnType<typeof planCompactPresentation>;
  hasResult: boolean;
  isError: boolean;
  slots: CompactSlots;
  call: CompactRenderBody | undefined;
  result: CompactRenderBody | undefined;
  contentCall: CompactRenderBody | undefined;
  contentResult: CompactRenderBody | undefined;
  reuse: boolean;
  fallback: (slot: CompactSlot) => Component;
  construct: (slot: CompactSlot, body: () => Component | undefined) => Component | undefined;
  duration: string | undefined;
  elapsedMs: number | undefined;
  timingEnabled: boolean;
}) {
  const { summary, context, theme, plan, slots } = input;
  const content = plan.useExpandedContent && Boolean(input.contentCall || input.contentResult);
  const contentCall = content && Boolean(input.contentCall);
  const contentResult = content && Boolean(input.contentResult);
  const ownedFailure = content && plan.useFailure ? summary?.failure : undefined;
  const slot = (name: CompactSlot, render: CompactRenderBody | undefined, contentOnly: boolean) =>
    render
      ? slots.construct(name, contentOnly, render, context, () => input.fallback(name), input.reuse)
      : undefined;
  // Construction order matches Pi, including callbacks that share producer state.
  const callBody = input.construct("call", () =>
    slot("call", contentCall ? input.contentCall : input.call, contentCall),
  );
  const resultBody = input.construct("result", () => {
    if (ownedFailure)
      return new Text(
        theme.fg(input.isError ? "error" : "warning", escapeControlChars(ownedFailure.details)),
        0,
        0,
      );
    return input.hasResult
      ? slot("result", contentResult ? input.contentResult : input.result, contentResult)
      : undefined;
  });
  const resultRendered =
    context.expanded &&
    resultBody !== undefined &&
    (Boolean(ownedFailure) || slots.successful("result", contentResult));
  const issues = summary
    ? summaryCompactIssues(summary, context.expanded)
    : { coverage: "unknown" as const, entries: [] };
  const noticeBody: Component = {
    render: (width) =>
      renderExpandedAttention(
        issues,
        resultRendered
          ? ownedFailure
            ? ownedFailure.ownedIssues
            : summary?.expandedResultOwnsIssues
          : undefined,
        theme,
        width,
      ),
    invalidate: () => undefined,
  };
  const details = new Container();
  if (resultBody) details.addChild(resultBody);
  details.addChild(noticeBody);
  const callSection = new Container();
  if (content && summary)
    callSection.addChild({
      render: (width) => [
        renderCompactRow(
          {
            name: input.name,
            expanded: true,
            phase: input.phase,
            summary,
            duration: input.duration,
            elapsedMs: input.elapsedMs,
            timingEnabled: input.timingEnabled,
          },
          theme,
          width,
        ),
      ],
      invalidate: () => undefined,
    });
  const ownsCall = !content && resultRendered && plan.covered && summary?.expandedResultOwnsCall;
  if (callBody && !ownsCall) callSection.addChild(callBody);
  return { callSection, details, content };
}
