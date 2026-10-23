import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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

export const sameContextUsage = (left: FooterContextUsage, right: FooterContextUsage): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent);

/** Whether two projections render the same footer; the model source only feeds derived fields. */
export const sameFooterHostProjection = (
  left: FooterHostProjection,
  right: FooterHostProjection,
): boolean =>
  left.model?.id === right.model?.id &&
  left.model?.provider === right.model?.provider &&
  left.model?.reasoning === right.model?.reasoning &&
  left.cwd === right.cwd &&
  left.branch === right.branch &&
  left.sessionName === right.sessionName &&
  left.subscription === right.subscription &&
  left.thinking === right.thinking &&
  left.providerCount === right.providerCount &&
  left.extensionStatuses.length === right.extensionStatuses.length &&
  Arr.every(left.extensionStatuses, (status, index) => {
    const other = right.extensionStatuses[index];
    return other !== undefined && status.id === other.id && status.text === other.text;
  });

const byStatusId: Order.Order<readonly [string, string]> = ([left], [right]) =>
  Fn.pipe(left, Str.localeCompare(right));

export const materializeFooterHostProjection = (options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext | undefined;
  readonly footerData: ReadonlyFooterDataProvider;
  readonly model: FooterModelView | undefined;
}): FooterHostProjection => {
  const { pi, ctx, footerData, model } = options;
  const extensionStatuses = invokeHostCallback<FooterHostProjection["extensionStatuses"]>(
    () =>
      Arr.flatMap(
        Arr.sort([...footerData.getExtensionStatuses().entries()], byStatusId),
        ([id, raw]: readonly [string, string]) => {
          const text = sanitizeTerminalLine(raw);
          return text ? [{ id, text }] : [];
        },
      ),
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
