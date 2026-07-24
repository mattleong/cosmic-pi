import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { HostCallbackBoundaryShape } from "./host-callback.ts";

export type FooterContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;
export type FooterModel = NonNullable<ExtensionContext["model"]>;

export interface FooterModelView {
  readonly source: FooterModel;
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
}

export interface FooterProjectedModel {
  readonly id: string;
  readonly provider: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
}

export interface FooterHostProjection {
  readonly model: FooterProjectedModel | undefined;
  readonly contextUsage: FooterContextUsage;
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
  callbacks: HostCallbackBoundaryShape,
  callback: () => A,
  fallback: A,
): A => callbacks.invoke("host-query", callback, fallback);

export const materializeModel = (
  ctx: ExtensionContext,
  callbacks: HostCallbackBoundaryShape,
): FooterModelView | undefined =>
  hostQuery<FooterModelView | undefined>(
    callbacks,
    () => {
      const source = ctx.model;
      return source
        ? Object.freeze({
            source,
            id: source.id,
            provider: source.provider,
            reasoning: source.reasoning,
            contextWindow: source.contextWindow,
          })
        : undefined;
    },
    undefined,
  );

export const materializeContextUsage = (
  ctx: ExtensionContext,
  callbacks: HostCallbackBoundaryShape,
): FooterContextUsage =>
  hostQuery<FooterContextUsage>(
    callbacks,
    () => {
      const usage = ctx.getContextUsage();
      return usage
        ? Object.freeze({
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          })
        : undefined;
    },
    undefined,
  );

const sanitizeStatus = (text: string) => text.replace(/[ \r\n\t]+/g, " ").trim();

export const materializeFooterHostProjection = (options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext | undefined;
  readonly footerData: ReadonlyFooterDataProvider;
  readonly callbacks: HostCallbackBoundaryShape;
  readonly model: FooterModelView | undefined;
  readonly contextUsage: FooterContextUsage;
}): FooterHostProjection => {
  const { pi, ctx, footerData, callbacks, model, contextUsage } = options;
  const extensionStatuses = hostQuery(
    callbacks,
    () =>
      [...footerData.getExtensionStatuses().entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, text]) => ({ id, text: sanitizeStatus(text) }))
        .filter(({ text }) => Boolean(text)),
    [] as Array<{ readonly id: string; readonly text: string }>,
  );
  return Object.freeze({
    model: model
      ? Object.freeze({
          id: model.id,
          provider: model.provider,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
        })
      : undefined,
    contextUsage,
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
    providerCount: hostQuery(callbacks, () => footerData.getAvailableProviderCount(), 0),
    extensionStatuses: Object.freeze(extensionStatuses),
  });
};
