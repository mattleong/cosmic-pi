import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { countLabel, invokeHostCallback } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import { compactPlainText } from "../preview/compact-row";
import { expandedSection } from "../preview/expanded-section";
import { previewIssuesSlot } from "../preview/preview-issues";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import { withCodePreviewRenderers, type CodePreviewShellOptions } from "./cooperative-tools";
import { getFallbackResultText } from "./data/results";
import { plainRows, safeContent } from "./native-safe-content";
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

/** Renderer-only native search presentation; it never discovers or activates tools itself. */
export function createNativeToolSearchRenderers(
  appearance: Pick<CodePreviewRendererAppearance, "scheduleAnimation"> &
    Partial<CodePreviewRendererAppearance>,
): ToolRenderers {
  const renderArguments = <Args>(args: Args, theme: Theme): Component =>
    section(theme, "Arguments", argumentsText(args));
  const renderOutput: NonNullable<ToolRenderers["renderResult"]> = (
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
  const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    const subject = nativeToolSearchSubject(args);
    const body = new Container();
    // Keep the shared issue slot outside theme fallback so failures cannot hide it.
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
  const renderResult: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderOutput(result, options, theme, context);
    if (options.isPartial)
      return safeContent(
        () => ({
          render: (width) =>
            new Text(toolRunningLine(theme, getCodePreviewAnimationFrame(context)), 0, 0).render(
              width,
            ),
          invalidate() {},
        }),
        plainRows("Running…", 1),
      );
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
  const options: CodePreviewShellOptions = {
    preserveSelfShell: false,
    displayName: DISPLAY_NAME,
    compactSummary: nativeToolSearchSummary,
    animateProgress: true,
    scheduleAnimation: appearance.scheduleAnimation,
    expandedContent: { renderCall: renderArguments, renderResult: renderOutput },
  };
  if (appearance.selfShell !== undefined) options.selfShell = appearance.selfShell;
  if (appearance.mode !== undefined) options.mode = appearance.mode;
  if (appearance.collapsedStyle !== undefined) options.collapsedStyle = appearance.collapsedStyle;
  return withCodePreviewRenderers({ name: "tool_search" }, { renderCall, renderResult }, options);
}
