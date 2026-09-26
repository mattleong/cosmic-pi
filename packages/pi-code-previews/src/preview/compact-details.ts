import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import type { CompactPhase, CompactSummary } from "../tools/compact-summary";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { renderCompactIssues } from "./compact-issues";
import { renderCompactRow } from "./compact-row";
import { CompactSlots, type CompactRenderBody, type CompactSlot } from "./compact-slots";

/**
 * Expanded order is fixed: heading, the call's issues with their details, unique call content,
 * then unique result content. Tools without content callbacks keep their original slots, and
 * their issues sit between the original call and result.
 */
export function composeCompactDetails(input: {
  name: string;
  context: ToolRenderContext<any, any>;
  theme: Theme;
  summary: CompactSummary | undefined;
  phase: CompactPhase;
  hasResult: boolean;
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
  const { summary, context, theme, slots } = input;
  const content = Boolean(summary && (input.contentCall || input.contentResult));
  const contentCall = content && Boolean(input.contentCall);
  const contentResult = content && Boolean(input.contentResult);
  const slot = (name: CompactSlot, render: CompactRenderBody | undefined, contentOnly: boolean) =>
    render
      ? slots.construct(name, contentOnly, render, context, () => input.fallback(name), input.reuse)
      : undefined;
  // Construction order matches Pi, including callbacks that share producer state.
  const callBody = input.construct("call", () =>
    slot("call", contentCall ? input.contentCall : input.call, contentCall),
  );
  const resultBody = input.construct("result", () =>
    input.hasResult
      ? slot("result", contentResult ? input.contentResult : input.result, contentResult)
      : undefined,
  );
  const issues: Component = {
    render: (width) => renderCompactIssues(summary?.issues, theme, width, true),
    invalidate: () => undefined,
  };
  const callSection = new Container();
  if (content && summary) {
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
    callSection.addChild(issues);
  }
  if (callBody) callSection.addChild(callBody);
  const details = new Container();
  if (!content) details.addChild(issues);
  if (resultBody) details.addChild(resultBody);
  return { callSection, details, content };
}
