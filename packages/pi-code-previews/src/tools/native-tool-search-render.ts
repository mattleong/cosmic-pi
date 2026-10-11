import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { countLabel, invokeHostCallback } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance, renderToolHeader } from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import { compactPlainText } from "../preview/compact-row";
import { expandedSection } from "../preview/expanded-section";
import { previewIssuesSlot } from "../preview/preview-issues";
import { withCodePreviewRenderers } from "./cooperative-tools";
import type { RenderCall, RendererState, RenderResult } from "./renderers/shared/types";
import { getFallbackResultText } from "./data/results";
import { plainRows, runningLine, safeContent } from "./native-safe-content";
import {
  nativeToolSearchReceipt,
  nativeToolSearchSubject,
  nativeToolSearchSummary,
} from "./native-tool-search-summary";

const DISPLAY_NAME = "tool search";

function argumentsText<Args>(args: Args): string {
  return invokeHostCallback(() => JSON.stringify(args, null, 2) ?? "", "");
}

function section(theme: Theme, title: string, text: string): Component {
  return safeContent(
    () => expandedSection(theme, title, new Text(compactPlainText(text), 0, 0)),
    `${title}\n${text}`,
  );
}

export function createNativeToolSearchRenderers(
  appearance: CodePreviewRendererAppearance,
): ToolRenderers {
  const renderArguments = <Args>(args: Args, theme: Theme): Component =>
    section(theme, "Arguments", argumentsText(args));
  const renderOutput: RenderResult<unknown, unknown, RendererState> = (
    result,
    _options,
    theme,
    context,
  ) => {
    const text = getFallbackResultText(result.content, context.showImages);
    return text
      ? section(theme, context.isPartial ? "Progress" : context.isError ? "Error" : "Output", text)
      : new Container();
  };
  const renderCall: RenderCall<unknown, RendererState> = (args, theme, context) => {
    const subject = nativeToolSearchSubject(args);
    const body = new Container();
    body.addChild(
      safeContent(
        () => ({
          render: (width) => [
            clipToWidth(renderToolHeader({ title: DISPLAY_NAME, subtitle: subject }, theme), width),
          ],
          invalidate() {},
        }),
        plainRows(`${DISPLAY_NAME} ${subject}`, 1),
      ),
    );
    body.addChild(previewIssuesSlot(context));
    if (context.expanded) body.addChild(renderArguments(args, theme));
    return body;
  };
  const renderResult: RenderResult<unknown, unknown, RendererState> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderOutput(result, options, theme, context);
    if (options.isPartial)
      return safeContent(() => runningLine(theme, context.state), plainRows("Running…", 1));
    const receipt = context.isError ? undefined : nativeToolSearchReceipt(result.details);
    const label = receipt
      ? `${countLabel(receipt.loaded.length, "tool")} listed`
      : context.isError
        ? "Error"
        : "Output";
    return safeContent(
      () => new Text(renderExpansionAffordance(label, false, theme), 0, 0),
      plainRows(`${label} · expand`, 1),
    );
  };
  return withCodePreviewRenderers(
    { name: "tool_search" },
    { renderCall, renderResult },
    {
      ...appearance,
      displayName: DISPLAY_NAME,
      compactSummary: nativeToolSearchSummary,
      animateProgress: true,
      expandedContent: { renderCall: renderArguments, renderResult: renderOutput },
    },
  );
}
