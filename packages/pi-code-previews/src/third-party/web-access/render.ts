import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as Fn from "effect/Function";
import * as Arr from "effect/Array";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { expandedSection } from "../../preview/expanded-section";
import { escapeControlChars } from "../../shared/terminal-text";
import { withCodePreviewRenderers } from "../../tools/cooperative-tools";
import { getFallbackResultText } from "../../tools/data/results";
import { plainRows, plainText } from "../../tools/native-safe-content";
import type {
  RenderCall,
  RendererState,
  RenderResult,
  ToolRenderContext,
} from "../../tools/renderers/shared/types";
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
import { hostContainer } from "../../shared/untrusted-value";

export const webAccessAdapter = {
  names: WEB_ACCESS_TOOLS,
  admits: admitsWebAccessSource,
  create: (name, downstream, appearance) =>
    isWebAccessTool(name) ? createWebAccessRenderers(name, downstream, appearance) : undefined,
} satisfies ThirdPartyAdapter;

type Context = ToolRenderContext<RendererState, unknown>;

export function createWebAccessRenderers(
  name: WebAccessTool,
  downstream: ToolRenderers | undefined,
  appearance: CodePreviewRendererAppearance,
): ToolRenderers {
  const label = WEB_ACCESS_LABELS[name];
  const originals = new WeakMap<Component, Component>();
  const failures = new WeakMap<object, Partial<Record<"call" | "result", readonly unknown[]>>>();

  function compose(
    slot: "call" | "result",
    input: readonly unknown[],
    context: Context,
    build: (lastComponent: Component | undefined) => Component | undefined,
    extra: () => Component,
    fallback: Component,
  ): Component {
    const { state } = context;
    const failed = failures.get(state);
    const prior = failed?.[slot];
    if (
      prior &&
      prior.length === input.length &&
      Arr.every(prior, (value, index) => value === input[index])
    )
      return fallback;
    const markFailed = () => failures.set(state, { ...failures.get(state), [slot]: input });
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
    const guarded = <A>(run: () => A, otherwise: () => A): A => {
      if (!broken)
        try {
          return run();
        } catch {
          broken = true;
          markFailed();
        }
      return otherwise();
    };
    const component: Component = {
      render: (width) =>
        guarded(
          () => body.render(width),
          () => fallback.render(width),
        ),
      invalidate() {
        guarded(() => body.invalidate(), Fn.constVoid);
        fallback.invalidate();
      },
      handleMouse: (event) => guarded(() => body.handleMouse?.(event), Fn.constUndefined),
    };
    if (original) originals.set(component, original);
    return component;
  }

  const renderCall: RenderCall<unknown, RendererState> = (args, theme, context) => {
    const full = invokeHostCallback(() => JSON.stringify(args, null, 2) ?? "", "");
    const subject = webAccessSubject(name, hostContainer(args));
    const fallback = context.expanded
      ? plainText(() => `${label}\nArguments\n${full}`)
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
  const renderResult: RenderResult<unknown, unknown, RendererState> = (
    result,
    options,
    theme,
    context,
  ) => {
    const raw = getFallbackResultText(result.content, context.showImages);
    const fallback = options.expanded ? plainText(raw) : plainRows(raw, 5);
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
