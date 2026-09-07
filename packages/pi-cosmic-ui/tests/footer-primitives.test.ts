import { expect, it } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { makeDefaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataProviderFixture,
} from "./support/host.ts";

it("keeps context visibility and decorator consumption independent of its rendered usage", () => {
  const defaults = makeDefaultResolvedCosmicUiConfig();
  const hidden = defaults.footer.order.filter((id) => id !== "context");
  const contributions: CosmicFooterTextContribution[] = [];
  let usage = { contextWindow: 100_000, tokens: 12_500, percent: 12.5 };
  const ctx = extensionContextFixture({
    model: { id: "model", provider: "provider", reasoning: false, contextWindow: 200_000 },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getCwd: () => "/project",
      getLeafId: () => null,
      getSessionName: () => undefined,
    },
    getContextUsage: () => usage,
  });
  const footer = createFooterComponent({
    pi: extensionApiFixture({ getThinkingLevel: () => "off" }),
    ctx: () => ctx,
    homeDirectory: () => undefined,
    footerData: footerDataProviderFixture({
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    }),
    theme: { fg: (_color, text) => text },
    registry: { snapshot: () => ({ contributions }), invalidate: () => undefined },
    callbacks: makeHostCallbackBoundary(),
    config: () => ({ ...defaults, footer: { ...defaults.footer, hidden } }),
    totals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
    gitStatus: () => undefined,
    pullRequestNumber: () => undefined,
  });

  const visible = footer.render(120);
  expect(visible.join("")).not.toBe("");
  contributions.push({
    kind: "text",
    id: "context.decorator",
    region: "metrics",
    decorates: "context",
    text: "context-prefix",
  });
  expect(footer.render(120)).toEqual(visible);

  usage = { ...usage, tokens: 50_000, percent: 50 };
  footer.invalidateContextUsage();
  expect(footer.render(120)).not.toEqual(visible);

  hidden.push("context");
  expect(footer.render(120).join("")).toContain("context-prefix");
  hidden.push("context.decorator");
  expect(footer.render(120)).toEqual([]);
  hidden.splice(hidden.indexOf("context"), 1);
  expect(footer.render(120).join("")).not.toBe("");
});
