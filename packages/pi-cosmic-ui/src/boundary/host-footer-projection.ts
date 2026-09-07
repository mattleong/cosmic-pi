import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { HostCallbackBoundaryContract } from "./host-callback.ts";
import { decodeContextUsage, decodeHostCount } from "./host-usage.ts";

export type FooterContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;
export type FooterModel = NonNullable<ExtensionContext["model"]>;

export interface FooterModelView {
  readonly source: FooterModel;
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
}

export interface FooterProjectedModel {
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
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

export const hostQuery = <A>(
  callbacks: HostCallbackBoundaryContract,
  callback: () => A,
  fallback: A,
): A => callbacks.invoke("host-query", callback, fallback);

export const materializeModel = (
  ctx: ExtensionContext,
  callbacks: HostCallbackBoundaryContract,
): FooterModelView | undefined =>
  hostQuery<FooterModelView | undefined>(
    callbacks,
    () => {
      const source = ctx.model;
      if (!source) return undefined;
      if (decodeHostCount(source.contextWindow) === undefined) return undefined;
      return Object.freeze({
        source,
        id: source.id,
        provider: source.provider,
        reasoning: source.reasoning,
      });
    },
    undefined,
  );

export const materializeContextUsage = (
  ctx: ExtensionContext,
  callbacks: HostCallbackBoundaryContract,
): FooterContextUsage =>
  hostQuery<FooterContextUsage>(
    callbacks,
    () => {
      const usage = ctx.getContextUsage();
      if (!usage) return undefined;
      const decoded = decodeContextUsage({
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      });
      return decoded ? Object.freeze(decoded) : undefined;
    },
    undefined,
  );

export const materializeFooterHostProjection = (options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext | undefined;
  readonly footerData: ReadonlyFooterDataProvider;
  readonly callbacks: HostCallbackBoundaryContract;
  readonly model: FooterModelView | undefined;
}): FooterHostProjection => {
  const { pi, ctx, footerData, callbacks, model } = options;
  // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
  const extensionStatuses = hostQuery(
    callbacks,
    () =>
      [...footerData.getExtensionStatuses().entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, text]) => ({ id, text: sanitizeTerminalLine(text) }))
        .filter(({ text }) => Boolean(text)),
    [] as Array<{ readonly id: string; readonly text: string }>,
  );
  return Object.freeze({
    model: model
      ? Object.freeze({
          id: model.id,
          provider: model.provider,
          reasoning: model.reasoning,
        })
      : undefined,
    cwd: ctx ? hostQuery(callbacks, () => ctx.sessionManager.getCwd(), "?") : "?",
    branch: hostQuery<string | null>(callbacks, () => footerData.getGitBranch(), null),
    sessionName: ctx
      ? hostQuery<string | undefined>(
          callbacks,
          () => ctx.sessionManager.getSessionName(),
          undefined,
        )
      : undefined,
    subscription:
      ctx && model
        ? hostQuery(callbacks, () => ctx.modelRegistry.isUsingOAuth(model.source), false)
        : false,
    thinking: hostQuery(callbacks, () => pi.getThinkingLevel(), "off"),
    providerCount: hostQuery(
      callbacks,
      () => decodeHostCount(footerData.getAvailableProviderCount()) ?? 0,
      0,
    ),
    extensionStatuses: Object.freeze(extensionStatuses),
  });
};
