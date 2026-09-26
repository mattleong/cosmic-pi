import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { renderCompactIssues } from "../../../preview/compact-issues";
import { createBuiltinCompactSummary } from "../../builtin-compact-summary";
import type { BuiltinCompactTool } from "../../builtin-subject";
import type { CompactIssue } from "../../compact-issues";
import { planCompactPresentation } from "../../compact-presentation";
import { getTextContent, isTruncated } from "../../data/results";
import { getObjectValue } from "../../../shared/helpers";
import type { RendererState, ToolRenderContext } from "./types";

type RenderResult<TContext> = (
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: TContext,
) => Component;

interface ResultIssues {
  readonly issues: readonly CompactIssue[];
  readonly cancelled: boolean;
}

interface PreviewIssues extends ResultIssues {
  readonly expanded: boolean;
}

const CALL_ISSUES = "codePreviewCallIssues";

/** One cached projection per result, arguments, and lifecycle. */
const issueCache = new WeakMap<object, { inputs: readonly unknown[]; value: ResultIssues }>();

/**
 * The same issues compact style would show, recomputed only when the result, arguments, or
 * lifecycle change. A projection that declines still reports truncated output.
 */
function resultIssues<TContext extends ToolRenderContext<any, any>>(
  tool: BuiltinCompactTool,
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  context: TContext,
): ResultIssues {
  const inputs = [result.content, result.details, context.args, context.isError, options.isPartial];
  const cached = issueCache.get(context.state);
  if (cached && inputs.every((value, index) => Object.is(value, cached.inputs[index])))
    return cached.value;
  const phase = options.isPartial ? "running" : "settled";
  let value: ResultIssues;
  try {
    const summary = createBuiltinCompactSummary(tool, {
      phase,
      args: context.args,
      result,
      context,
    });
    const plan = planCompactPresentation({
      summary,
      phase,
      isError: context.isError,
      errorText: getTextContent(result.content),
    });
    const issues = [...(plan.collapsedSummary.issues ?? [])];
    if (!summary && isTruncated(result.details))
      issues.push({ severity: "warning", code: "output-truncated", message: "Output was cut off" });
    value = { issues, cancelled: plan.summary?.outcome === "cancelled" };
  } catch {
    value = { issues: [], cancelled: false };
  }
  issueCache.set(context.state, { inputs, value });
  return value;
}

/** Warnings visible from the arguments alone, before any result exists. */
export function argumentIssues<TContext extends ToolRenderContext<any, any>>(
  tool: BuiltinCompactTool,
  context: TContext,
): readonly CompactIssue[] {
  try {
    return (
      createBuiltinCompactSummary(tool, {
        phase: "pending",
        args: context.args,
        result: undefined,
        context,
      })?.issues ?? []
    );
  } catch {
    return [];
  }
}

function renderPreviewIssues(entry: PreviewIssues, theme: Theme, width: number): string[] {
  const rows = renderCompactIssues(entry.issues, theme, width, entry.expanded, "");
  return rows.length === 0 && entry.cancelled ? [theme.fg("muted", "Cancelled")] : rows;
}

/**
 * Preview style puts the same issue lines as compact style directly under the heading. Tools
 * that render issues in their call slot (`"call"`) receive them through shared state; the
 * others show them above the result body.
 */
export function withPreviewIssues<TContext extends ToolRenderContext<any, any>>(
  tool: BuiltinCompactTool,
  render: RenderResult<TContext>,
  placement: "result" | "call" = "result",
): RenderResult<TContext> {
  return (result, options, theme, context) => {
    const body = render(result, options, theme, context);
    const entry: PreviewIssues = {
      ...resultIssues(tool, result, options, context),
      expanded: options.expanded,
    };
    if (placement === "call") {
      context.state[CALL_ISSUES] = entry;
      return body;
    }
    if (entry.issues.length === 0 && !entry.cancelled) return body;
    const container = new Container();
    container.addChild({
      render: (width) => renderPreviewIssues(entry, theme, width),
      invalidate: () => undefined,
    });
    container.addChild(body);
    return container;
  };
}

/**
 * Issue lines under a call heading. Before a result exists they come from the arguments, so
 * risky commands and secrets are flagged while a call still awaits approval.
 */
export function previewCallIssues(
  state: RendererState,
  theme: Theme,
  pending: () => readonly CompactIssue[],
): Component {
  let early: readonly CompactIssue[] | undefined;
  return {
    render(width) {
      const entry = getObjectValue(state, CALL_ISSUES);
      const issues = getObjectValue(entry, "issues");
      if (Array.isArray(issues))
        return renderPreviewIssues(
          {
            issues,
            cancelled: getObjectValue(entry, "cancelled") === true,
            expanded: getObjectValue(entry, "expanded") === true,
          },
          theme,
          width,
        );
      early ??= pending();
      return renderCompactIssues(early, theme, width, false, "");
    },
    invalidate: () => {
      early = undefined;
    },
  };
}
