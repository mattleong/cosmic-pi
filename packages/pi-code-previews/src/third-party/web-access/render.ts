import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { expandedSection } from "../../preview/expanded-section";
import { escapeControlChars } from "../../shared/terminal-text";
import { withCodePreviewRenderers } from "../../tools/cooperative-tools";
import { getFallbackResultText } from "../../tools/data/results";
import { plainRows } from "../../tools/native-safe-content";
import type { ToolRenderContext } from "../../tools/renderers/shared/types";
import { webAccessSubject } from "./evidence";
import {
  admitsWebAccessSource,
  isWebAccessTool,
  WEB_ACCESS_LABELS,
  WEB_ACCESS_TOOLS,
  type WebAccessTool,
} from "./identity";
import type { ThirdPartyAdapter } from "../registry";
import { webAccessSummary } from "./summary";

export const webAccessAdapter = {
  names: WEB_ACCESS_TOOLS,
  admits: admitsWebAccessSource,
  create: (name, downstream, appearance) =>
    isWebAccessTool(name) ? createWebAccessRenderers(name, downstream, appearance) : undefined,
} satisfies ThirdPartyAdapter;

type Context = ToolRenderContext<any, any>;

function argumentsText<Args>(args: Args): string {
  return invokeHostCallback(() => JSON.stringify(args, null, 2) ?? "", "");
}

function rawOutput(result: AgentToolResult<unknown>, context: Context): string {
  return getFallbackResultText(result.content, context.showImages);
}

/** No provider imports or execution access. Pi retains image rendering and all result objects. */
export function createWebAccessRenderers(
  name: WebAccessTool,
  downstream: ToolRenderers | undefined,
  appearance: CodePreviewRendererAppearance,
): ToolRenderers {
  const label = WEB_ACCESS_LABELS[name];
  const originals = new WeakMap<Component, Component>();
  const failures = new WeakMap<object, Partial<Record<"call" | "result", readonly unknown[]>>>();

  /** Preserve opaque components/caches/mouse input, but never replay a failed slot for this input. */
  function compose(
    slot: "call" | "result",
    input: readonly unknown[],
    context: Context,
    build: (lastComponent: Component | undefined) => Component | undefined,
    extra: () => Component,
    fallback: Component,
  ): Component {
    const failed = failures.get(context.state);
    const prior = failed?.[slot];
    if (
      prior &&
      prior.length === input.length &&
      prior.every((value, index) => value === input[index])
    )
      return fallback;
    const markFailed = () =>
      failures.set(context.state, { ...failures.get(context.state), [slot]: input });
    let original: Component | undefined;
    let body: Component;
    try {
      original = build(context.lastComponent && originals.get(context.lastComponent));
      const container = new Container();
      if (original) container.addChild(original);
      container.addChild(extra());
      body = container;
    } catch {
      markFailed();
      return fallback;
    }
    let broken = false;
    const component: Component = {
      render(width) {
        if (!broken) {
          try {
            return body.render(width);
          } catch {
            broken = true;
            markFailed();
          }
        }
        return fallback.render(width);
      },
      invalidate() {
        if (!broken) {
          try {
            body.invalidate();
          } catch {
            broken = true;
            markFailed();
          }
        }
        fallback.invalidate();
      },
      handleMouse(event) {
        if (!broken) {
          try {
            return body.handleMouse?.(event);
          } catch {
            broken = true;
            markFailed();
          }
        }
        return undefined;
      },
    };
    if (original) originals.set(component, original);
    return component;
  }

  const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    const full = argumentsText(args);
    const subject = webAccessSubject(name, args);
    const fallback = context.expanded
      ? new Text(escapeControlChars(`${label}\nArguments\n${full}`), 0, 0)
      : plainRows(`${label} ${subject}`, 2);
    return compose(
      "call",
      [args],
      context,
      (lastComponent) => downstream?.renderCall?.(args, theme, { ...context, lastComponent }),
      () => {
        if (context.expanded)
          return expandedSection(theme, "Arguments", new Text(escapeControlChars(full), 0, 0));
        return downstream?.renderCall
          ? new Container()
          : new Text(renderToolHeader({ title: label, subtitle: subject }, theme), 0, 0);
      },
      fallback,
    );
  };
  const renderResult: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    const raw = rawOutput(result, context);
    const fallback = options.expanded ? new Text(escapeControlChars(raw), 0, 0) : plainRows(raw, 5);
    return compose(
      "result",
      [result.content, result.details],
      context,
      (lastComponent) =>
        downstream?.renderResult?.(result, options, theme, { ...context, lastComponent }),
      () =>
        options.expanded
          ? expandedSection(theme, "Raw result", new Text(escapeControlChars(raw), 0, 0))
          : downstream?.renderResult
            ? new Container()
            : fallback,
      fallback,
    );
  };
  return withCodePreviewRenderers(
    { name, label },
    { renderCall, renderResult },
    {
      ...appearance,
      preserveSelfShell: false,
      displayName: label,
      compactSummary: webAccessSummary(name),
      animateProgress: true,
    },
  );
}
