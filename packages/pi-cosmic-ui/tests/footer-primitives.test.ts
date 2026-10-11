import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { makeDefaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
import { applyTextDecorations, orderedContributions } from "../src/footer/builtin-contributions.ts";
import { contributionText, ranked } from "../src/footer/contributions.ts";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";

const footer = (options: {
  readonly contributions: readonly CosmicFooterTextContribution[];
  readonly config: Parameters<typeof createFooterComponent>[0]["config"];
  readonly contextUsage: ExtensionContext["getContextUsage"];
  readonly branch?: string;
}) => {
  const ctx = extensionContextFixture({
    model: { id: "model", provider: "provider", reasoning: false, contextWindow: 200_000 },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getCwd: () => "/project",
      getLeafId: () => null,
      getSessionName: () => undefined,
    },
    getContextUsage: options.contextUsage,
  });
  return createFooterComponent({
    pi: extensionApiFixture({ getThinkingLevel: () => "off" }),
    ctx: () => ctx,
    footerData: opaqueFixture({
      getGitBranch: () => options.branch ?? null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    }),
    theme: plainTheme,
    registry: { snapshot: () => ({ contributions: options.contributions }) },
    config: options.config,
    projection: () => ({
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      gitStatus: undefined,
      pullRequestNumber: undefined,
      homeDirectory: undefined,
    }),
  });
};

it("keeps context visibility and decorator consumption independent of its rendered usage", () => {
  const defaults = makeDefaultResolvedCosmicUiConfig();
  const hidden = defaults.footer.order.filter((id) => id !== "context");
  const contributions: CosmicFooterTextContribution[] = [];
  let usage = { contextWindow: 100_000, tokens: 12_500, percent: 12.5 };
  const component = footer({
    contributions,
    config: () => ({ ...defaults, footer: { ...defaults.footer, hidden } }),
    contextUsage: () => usage,
  });

  const visible = component.render(120);
  expect(visible.join("")).not.toBe("");
  contributions.push({
    kind: "text",
    id: "context.decorator",
    region: "metrics",
    decorates: "context",
    text: "context-prefix",
  });
  expect(component.render(120)).toEqual(visible);

  usage = { ...usage, tokens: 50_000, percent: 50 };
  component.invalidateContextUsage();
  expect(component.render(120)).not.toEqual(visible);

  hidden.push("context");
  expect(component.render(120).join("")).toContain("context-prefix");
  hidden.push("context.decorator");
  expect(component.render(120)).toEqual([]);
  hidden.splice(hidden.indexOf("context"), 1);
  expect(component.render(120).join("")).not.toBe("");
});

it.each(["comfortable", "compact"] as const)(
  "honors configured repository order in %s density",
  (density) => {
    const defaults = makeDefaultResolvedCosmicUiConfig();
    const markers = { branch: "branch-marker", location: "project" };
    for (const order of [
      ["branch", "location"],
      ["location", "branch"],
    ] as const) {
      const rendered = footer({
        contributions: [],
        branch: markers.branch,
        config: () => ({ ...defaults, footer: { ...defaults.footer, density, order } }),
        contextUsage: () => undefined,
      })
        .render(120)
        .join("\n");
      const first = rendered.indexOf(markers[order[0]]);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(rendered.indexOf(markers[order[1]])).toBeGreaterThan(first);
    }
  },
);

it("puts configured contributions first, by their last configured position, without mutating inputs", () => {
  const values: CosmicFooterTextContribution[] = ["custom", "location", "branch", "model"].map(
    (id) => ({
      kind: "text",
      id,
      region: "identity",
      text: id,
      ...(id !== "custom" && { order: 200 }),
    }),
  );
  const originals = values.map((value) => ({ ...value }));
  const defaults = makeDefaultResolvedCosmicUiConfig();
  const ordered = orderedContributions(values, {
    ...defaults,
    footer: { ...defaults.footer, order: ["branch", "location", "branch"] },
  });
  // Ordered, then unordered; a repeated id takes its last position, so location leads branch.
  expect(ordered.map((value) => value.id)).toEqual(["location", "branch", "model", "custom"]);
  expect(values).toEqual(originals);
});

it("orders an unordered contribution the same way on a line and across detail lines", () => {
  const values: CosmicFooterTextContribution[] = [
    { kind: "text", id: "unordered", region: "identity", text: "unordered" },
    { kind: "text", id: "ordered", region: "identity", text: "ordered", order: 300 },
  ];
  const lineOrder = ranked(values).map((value) => value.id);
  const passOrder = orderedContributions(values, makeDefaultResolvedCosmicUiConfig()).map(
    (value) => value.id,
  );
  expect(lineOrder).toEqual(passOrder);
});

it.each([undefined, "", "short"])(
  "preserves consumed decorations with compact text %j without mutating inputs",
  (compactText) => {
    const target = Object.freeze({
      kind: "text",
      id: "target",
      region: "identity",
      text: "full",
      compactText,
    } satisfies CosmicFooterTextContribution);
    const decorator = Object.freeze({
      ...target,
      id: "prefix",
      text: "prefix:",
      decorates: target.id,
    });
    const entries = Object.freeze([decorator, target]);
    const decorated = applyTextDecorations(entries);
    expect(decorated).toEqual([
      {
        ...target,
        text: decorator.text + target.text,
        compactText: compactText === undefined ? undefined : decorator.text + compactText,
      },
    ]);
    expect(contributionText(decorated[0]!, true)).toBe(
      decorator.text + (compactText ?? target.text),
    );
    expect(applyTextDecorations([decorator])).toEqual([decorator]);
  },
);

it("uses compact text for labeled contributions in compact mode", () => {
  const defaults = makeDefaultResolvedCosmicUiConfig();
  const rendered = footer({
    contributions: [
      {
        kind: "text",
        id: "labeled.detail",
        region: "details",
        text: "full detail",
        compactText: "compact detail",
        label: "Provider",
      },
    ],
    config: () => defaults,
    contextUsage: () => undefined,
  })
    .render(60)
    .join("\n");
  expect(rendered).toContain("compact detail");
  expect(rendered).not.toContain("full detail");
});

it("renders a labeled detail once even when its id is extension-scoped", () => {
  const rendered = footer({
    contributions: [
      { kind: "text", id: "extension.usage", region: "details", text: "plain detail", label: "P" },
    ],
    config: makeDefaultResolvedCosmicUiConfig,
    contextUsage: () => undefined,
  })
    .render(120)
    .join("\n");
  expect(rendered.split("plain detail")).toHaveLength(2);
});
