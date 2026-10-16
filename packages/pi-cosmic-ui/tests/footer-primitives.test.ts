import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataFixture,
  modelFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { defaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
import { applyTextDecorations, orderedContributions } from "../src/footer/builtin-contributions.ts";
import { contributionText, ranked } from "../src/footer/contributions.ts";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";

const footer = (options: {
  readonly contributions: readonly CosmicFooterTextContribution[];
  readonly config: Parameters<typeof createFooterComponent>[0]["config"];
  readonly contextUsage: ExtensionContext["getContextUsage"];
  readonly branch?: string;
  readonly pullRequest?: { readonly number: number; readonly url: string | undefined };
}) => {
  const ctx = extensionContextFixture({
    model: modelFixture({
      id: "model",
      provider: "provider",
      reasoning: false,
      contextWindow: 200_000,
    }),
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
    footerData: footerDataFixture({
      getGitBranch: () => options.branch ?? null,
      getAvailableProviderCount: () => 1,
    }),
    theme: plainTheme,
    registry: { snapshot: () => ({ contributions: options.contributions }) },
    config: options.config,
    projection: () => ({
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      gitStatus: undefined,
      pullRequestNumber: options.pullRequest?.number,
      pullRequestUrl: options.pullRequest?.url,
      homeDirectory: undefined,
    }),
  });
};

it("keeps context visibility and decorator consumption independent of its rendered usage", () => {
  const defaults = defaultResolvedCosmicUiConfig();
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
    const defaults = defaultResolvedCosmicUiConfig();
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

it.each(["comfortable", "compact"] as const)(
  "links the PR to its reported URL without changing visible %s footer text",
  (density) => {
    const defaults = defaultResolvedCosmicUiConfig();
    const url = "https://git.example.test/team/project/pull/1742";
    const options = {
      contributions: [
        {
          kind: "text",
          id: "git.trailing",
          region: "identity",
          text: "+4L",
          align: "right",
        } as const,
      ],
      branch: "feature/你好-wide-branch",
      config: () => ({ ...defaults, footer: { ...defaults.footer, density } }),
      contextUsage: () => undefined,
    };
    const linked = footer({ ...options, pullRequest: { number: 1742, url } });
    const plain = footer({ ...options, pullRequest: { number: 1742, url: undefined } });
    let linkedLines = 0;
    for (let width = 0; width <= 140; width++) {
      const lines = linked.render(width);
      expect(lines.map(stripTerminalSequences)).toEqual(
        plain.render(width).map(stripTerminalSequences),
      );
      for (const line of lines) {
        const text = stripTerminalSequences(line);
        const start = text.indexOf("PR #1742");
        const startColumn = start < 0 ? -1 : visibleWidth(text.slice(0, start));
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (startColumn >= 0) linkedLines++;
        // Include appended text to prove that even the final hyperlink is closed.
        for (let column = 0; column <= visibleWidth(line) + 1; column++) {
          const inPr = startColumn >= 0 && column >= startColumn && column < startColumn + 8;
          expect(getOsc8LinkAtColumn(`${line} x`, column)).toBe(inPr ? url : undefined);
        }
      }
    }
    expect(linkedLines).toBeGreaterThan(0);
  },
);

it("does not link a partially clipped PR or leak into following right-aligned text", () => {
  const defaults = defaultResolvedCosmicUiConfig();
  const component = footer({
    contributions: [
      { kind: "text", id: "git.trailing", region: "identity", text: "+4L", align: "right" },
    ],
    branch: "branch",
    pullRequest: { number: 1742, url: "https://git.example.test/team/project/pull/1742" },
    config: () => ({
      ...defaults,
      footer: { ...defaults.footer, hidden: ["branch", "location", "model", "context"] },
    }),
    contextUsage: () => undefined,
  });
  let clippedLines = 0;
  for (let width = 1; width < 13; width++) {
    for (const line of component.render(width)) {
      const text = stripTerminalSequences(line);
      if (text.includes("PR")) clippedLines++;
      expect(text).not.toContain("PR #1742");
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      for (let column = 0; column <= visibleWidth(line) + 1; column++)
        expect(getOsc8LinkAtColumn(`${line} x`, column)).toBeUndefined();
    }
  }
  expect(clippedLines).toBeGreaterThan(0);
});

it.each([
  "https://git.example.test/team/project/pull/1742\x1b]52;c;payload\x07",
  "https://git.example.test/team/project/pull/1742\x9c",
  "https://git.example.test/team/project/pull/1742\nnext-line",
  "javascript:alert(1742)",
])("keeps an unsafe projected URL %j out of terminal output", (url) => {
  const options = {
    contributions: [],
    branch: "branch",
    config: defaultResolvedCosmicUiConfig,
    contextUsage: () => undefined,
  };
  expect(footer({ ...options, pullRequest: { number: 1742, url } }).render(120)).toEqual(
    footer({ ...options, pullRequest: { number: 1742, url: undefined } }).render(120),
  );
});

it("does not add a PR or hyperlink without a PR or branch", () => {
  const options = {
    contributions: [],
    config: defaultResolvedCosmicUiConfig,
    contextUsage: () => undefined,
  };
  for (const component of [
    footer({ ...options, branch: "branch" }),
    footer({
      ...options,
      pullRequest: { number: 1742, url: "https://git.example.test/team/project/pull/1742" },
    }),
  ]) {
    for (const line of component.render(120)) {
      expect(stripTerminalSequences(line)).not.toContain("PR #");
      for (let column = 0; column <= visibleWidth(line) + 1; column++)
        expect(getOsc8LinkAtColumn(`${line} x`, column)).toBeUndefined();
    }
  }
});

it("puts configured contributions first, by their last configured position, without mutating inputs", () => {
  const values = ["custom", "location", "branch", "model"].map(
    (id): CosmicFooterTextContribution =>
      id === "custom"
        ? { kind: "text", id, region: "identity", text: id }
        : { kind: "text", id, region: "identity", text: id, order: 200 },
  );
  const originals = values.map((value) => ({ ...value }));
  const defaults = defaultResolvedCosmicUiConfig();
  const ordered = orderedContributions(values, {
    ...defaults,
    footer: { ...defaults.footer, order: ["branch", "location", "branch"] },
  });
  expect(ordered.map((value) => value.id)).toEqual(["location", "branch", "model", "custom"]);
  expect(values).toEqual(originals);
});

it("orders an unordered contribution the same way on a line and across detail lines", () => {
  const values: CosmicFooterTextContribution[] = [
    { kind: "text", id: "unordered", region: "identity", text: "unordered" },
    { kind: "text", id: "ordered", region: "identity", text: "ordered", order: 300 },
  ];
  const lineOrder = ranked(values).map((value) => value.id);
  const passOrder = orderedContributions(values, defaultResolvedCosmicUiConfig()).map(
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
  const defaults = defaultResolvedCosmicUiConfig();
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
    config: defaultResolvedCosmicUiConfig,
    contextUsage: () => undefined,
  })
    .render(120)
    .join("\n");
  expect(rendered.split("plain detail")).toHaveLength(2);
});
