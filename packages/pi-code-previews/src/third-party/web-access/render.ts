import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as Fn from "effect/Function";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { expandedArguments, expandedSection } from "../../preview/expanded-section";
import { previewHeadingText } from "../../preview/heading-wrap";
import { headingIsOwnCall, headingShowedSubject } from "../../preview/heading-coverage";
import { compactSingleLine } from "../../preview/compact-row";
import { escapeControlChars, replaceSgrSequences } from "../../shared/terminal-text";
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
import {
  hostContainer,
  hostObject,
  hostValue,
  ownField,
  type HostObject,
} from "../../shared/untrusted-value";

export const webAccessAdapter = {
  names: WEB_ACCESS_TOOLS,
  admits: admitsWebAccessSource,
  create: (name, downstream, appearance) =>
    isWebAccessTool(name) ? createWebAccessRenderers(name, downstream, appearance) : undefined,
} satisfies ThirdPartyAdapter;

type Context = ToolRenderContext<RendererState, unknown>;

const visibleWords = (text: string): string =>
  Fn.pipe(
    replaceSgrSequences(text, () => ""),
    Str.replace(/\s+/gu, " "),
    Str.trim,
  );

/**
 * The appended raw evidence, unless the provider's own rendering already shows all of it at this
 * width; clipped or reworded provider output keeps the evidence.
 */
function unlessShownBy(
  original: Component | undefined,
  evidence: string,
  section: Component,
): Component {
  const wanted = visibleWords(evidence);
  return {
    render(width) {
      const shown = original ? visibleWords(Arr.join(original.render(width), " ")) : "";
      return wanted && Fn.pipe(shown, Str.includes(wanted)) ? [] : section.render(width);
    },
    invalidate: () => section.invalidate(),
  };
}

/**
 * The call's arguments, unless they are one text argument the heading showed whole and exactly as
 * its subject, such as a source check's claim: the adapter's own heading above them, which wraps
 * rather than clips, or a shell heading that reports showing the whole subject. A heading the
 * provider draws itself proves nothing.
 */
function unlessHeadingShowsOnlyArgument(
  state: RendererState,
  input: HostObject | undefined,
  subject: string,
  providerHeading: boolean,
  section: Component,
): Component {
  const only = invokeHostCallback((): string | undefined => {
    const keys = input ? Rec.keys(input) : [];
    const value = keys.length === 1 ? ownField(input, keys[0] ?? "") : undefined;
    return Predicate.isString(value) ? value : undefined;
  }, undefined);
  const exact = only !== undefined && only === subject && compactSingleLine(only) === only;
  return {
    render(width) {
      const shown =
        exact && (!providerHeading || (headingShowedSubject(state) && !headingIsOwnCall(state)));
      return shown ? [] : section.render(width);
    },
    invalidate: () => section.invalidate(),
  };
}

// Built outside the render call, so the heading holds only its text, never the call's arguments.
const fixedHeading = (text: string): Component => previewHeadingText(() => text);

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
    extra: (original: Component | undefined) => Component,
    fallback: Component,
    present: (original: Component) => Component = Fn.identity,
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
      if (original) container.addChild(present(original));
      container.addChild(extra(original));
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
      (original) => {
        // Without the provider's own call rendering, the adapter draws the heading.
        const heading = downstream?.renderCall
          ? new Container()
          : fixedHeading(renderToolHeader({ title: label, subtitle: subject }, theme));
        if (!context.expanded) return heading;
        const body = new Container();
        body.addChild(heading);
        if (!(Predicate.isObject(args) && Rec.isEmptyRecord(args)))
          body.addChild(
            unlessHeadingShowsOnlyArgument(
              context.state,
              hostObject(args),
              subject,
              // A provider's own call heading may show anything, so only its drawn text counts.
              downstream?.renderCall !== undefined,
              unlessShownBy(
                original,
                invokeHostCallback(() => JSON.stringify(args) ?? "", ""),
                expandedArguments(theme, hostValue(args)),
              ),
            ),
          );
        return body;
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
      (original) =>
        options.expanded
          ? unlessShownBy(
              original,
              raw,
              expandedSection(theme, "Raw result", new Text(escapeControlChars(raw), 0, 0)),
            )
          : downstream?.renderResult
            ? new Container()
            : fallback,
      fallback,
      // Expanded, the provider's result is a body section, indented as the others are.
      (original) => (options.expanded ? expandedSection(theme, undefined, original) : original),
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
