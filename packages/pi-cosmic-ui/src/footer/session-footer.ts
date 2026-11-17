import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { nodeDisplayHomeDirectory } from "pi-cosmic-core/platform/node-builtins";
import type { CosmicFooterTextContribution, CosmicFooterTheme } from "../protocol/protocol.ts";
import { clipToWidth } from "../manager/chrome.ts";
import { applyTextDecorations, builtinContributions } from "./builtin-contributions.ts";
import { footerLines } from "./component.ts";
import { DEFAULT_CONTRIBUTION_ORDER } from "./contributions.ts";

/** What a footer says about a session other than the host's own, such as a subagent's. */
export interface SessionFooter {
  /** `provider` and `id` as the footer names a model: `openai-codex / gpt-6-luna`. */
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly thinking: string;
  /** A mark before the thinking level, such as `⚡` for fast mode. */
  readonly thinkingMark?: string | undefined;
  readonly cwd: string;
  readonly totals: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
  };
  /** The share of the context window in use, when the session reports it. */
  readonly contextPercent?: number | undefined;
}

const COMPACT_BELOW_COLUMNS = 72;

/**
 * The footer's own lines for another session: its model and context, its directory, and its
 * usage, laid out by the same code as the host's footer so the two read alike. It shows what the
 * caller knows; the host's settings, repository state, and provider usage belong to the host's
 * footer alone.
 */
export function renderSessionFooter(
  session: SessionFooter,
  width: number,
  theme: CosmicFooterTheme,
): string[] {
  if (width <= 0) return [];
  const builtin = builtinContributions(
    {
      model: session.model && { ...session.model, reasoning: true },
      cwd: session.cwd,
      branch: null,
      sessionName: undefined,
      subscription: false,
      thinking: session.thinking,
      // A subagent's provider is rarely the host's, so it is always named.
      providerCount: 2,
      extensionStatuses: [],
    },
    {
      totals: session.totals,
      gitStatus: undefined,
      pullRequestNumber: undefined,
      pullRequestUrl: undefined,
      homeDirectory: invokeHostCallback(nodeDisplayHomeDirectory, undefined),
    },
    new Map(),
  );
  const mark: CosmicFooterTextContribution[] = session.thinkingMark
    ? [
        {
          kind: "text",
          id: "effort.mark",
          region: "identity",
          text: session.thinkingMark,
          decorates: "effort",
        },
      ]
    : [];
  // A session that doesn't report its context share shows no meter, rather than an unknown one.
  const known = Arr.filter(
    builtin,
    (entry) => entry.id !== "context" || session.contextPercent !== undefined,
  );
  const text = applyTextDecorations(
    Arr.sort(
      [...known, ...mark],
      Order.mapInput(
        Order.Number,
        (entry: CosmicFooterTextContribution) => entry.order ?? DEFAULT_CONTRIBUTION_ORDER,
      ),
    ),
  );
  const usage =
    session.contextPercent === undefined
      ? undefined
      : { tokens: null, contextWindow: 0, percent: session.contextPercent };
  return Arr.map(
    footerLines(text, width, theme, width < COMPACT_BELOW_COLUMNS, usage, undefined),
    (line) => clipToWidth(line, width, ""),
  );
}
