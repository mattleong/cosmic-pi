import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getOsc8LinkAtColumn,
  resetCapabilitiesCache,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataFixture,
  modelFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { defaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
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

const supportHyperlinks = (hyperlinks: boolean) =>
  setCapabilities({ ...getCapabilities(), hyperlinks });

const links = (lines: readonly string[]) =>
  lines.flatMap((line) =>
    Array.from({ length: visibleWidth(line) }, (_, column) => getOsc8LinkAtColumn(line, column)),
  );

afterEach(resetCapabilitiesCache);

it.each([true, false])(
  "links a fitted PR only when the terminal supports links (%s)",
  (supported) => {
    const url = "https://git.example.test/team/project/pull/1742";
    supportHyperlinks(supported);
    const render = (link: string | undefined) =>
      footer({
        contributions: [],
        branch: "branch",
        pullRequest: { number: 1742, url: link },
        config: defaultResolvedCosmicUiConfig,
        contextUsage: () => undefined,
      }).render(120);
    const lines = render(url);
    expect(links(lines).includes(url)).toBe(supported);
    expect(lines.join("\n") === render(undefined).join("\n")).toBe(!supported);
  },
);

it("does not link a partially clipped PR or leak into following right-aligned text", () => {
  supportHyperlinks(true);
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
  "javascript:alert(1742)",
])("keeps an unsafe projected URL %j out of terminal output", (url) => {
  supportHyperlinks(true);
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
