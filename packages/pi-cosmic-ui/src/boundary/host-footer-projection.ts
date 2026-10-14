import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback, sanitizeTerminalLine } from "pi-cosmic-core";
import { decodeContextUsage, decodeHostCount } from "./host-usage.ts";

export type FooterContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;
type HostModel = NonNullable<ExtensionContext["model"]>;
export type FooterModel = Parameters<ExtensionContext["modelRegistry"]["isUsingOAuth"]>[0];

const isFooterModel = (model: HostModel): model is FooterModel => Predicate.isString(model.api);

export interface FooterProjectedModel {
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
}

export interface FooterModelView extends FooterProjectedModel {
  readonly source: FooterModel;
}

export interface FooterHostProjection {
  readonly model: FooterProjectedModel | undefined;
  readonly cwd: string;
  readonly branch: string | null;
  readonly sessionName: string | undefined;
  readonly subscription: boolean;
  readonly thinking: string;
  readonly providerCount: number;
  readonly extensionStatuses: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
  }>;
}

export const materializeModel = (ctx: ExtensionContext): FooterModelView | undefined =>
  invokeHostCallback<FooterModelView | undefined>(() => {
    const source = ctx.model;
    if (!source || !isFooterModel(source) || decodeHostCount(source.contextWindow) === undefined)
      return undefined;
    return Object.freeze({
      source,
      id: source.id,
      provider: source.provider,
      reasoning: source.reasoning,
    });
  }, undefined);

export const materializeContextUsage = (ctx: ExtensionContext): FooterContextUsage =>
  invokeHostCallback<FooterContextUsage>(() => {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    const decoded = decodeContextUsage({
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    });
    return decoded ? Object.freeze(decoded) : undefined;
  }, undefined);

export const materializeFooterHostProjection = (options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext | undefined;
  readonly footerData: ReadonlyFooterDataProvider;
  readonly model: FooterModelView | undefined;
}): FooterHostProjection => {
  const { pi, ctx, footerData, model } = options;
  const extensionStatuses = invokeHostCallback<FooterHostProjection["extensionStatuses"]>(
    () =>
      [...footerData.getExtensionStatuses().entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .flatMap(([id, raw]) => {
          const text = sanitizeTerminalLine(raw);
          return text ? [{ id, text }] : [];
        }),
    [],
  );
  return Object.freeze({
    model,
    cwd: ctx ? invokeHostCallback(() => ctx.sessionManager.getCwd(), "?") : "?",
    branch: invokeHostCallback<string | null>(() => footerData.getGitBranch(), null),
    sessionName: ctx
      ? invokeHostCallback<string | undefined>(() => ctx.sessionManager.getSessionName(), undefined)
      : undefined,
    subscription:
      ctx && model
        ? invokeHostCallback(() => ctx.modelRegistry.isUsingOAuth(model.source), false)
        : false,
    thinking: invokeHostCallback(() => pi.getThinkingLevel(), "off"),
    providerCount: invokeHostCallback(
      () => decodeHostCount(footerData.getAvailableProviderCount()) ?? 0,
      0,
    ),
    extensionStatuses: Object.freeze(extensionStatuses),
  });
};
