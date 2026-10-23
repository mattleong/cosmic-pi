import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getOsc8LinkAtColumn,
  resetCapabilitiesCache,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataFixture,
  modelFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { defaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
import { clipToWidth } from "../src/manager/chrome.ts";
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
  Arr.flatMap(lines, (line) =>
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
    expect(Arr.join(lines, "\n") === Arr.join(render(undefined), "\n")).toBe(!supported);
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
      if (Fn.pipe(text, Str.includes("PR"))) clippedLines++;
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

it("re-renders host changes behind unchanged identities, and the theme after invalidation", () => {
  let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "off";
  let branch = "main";
  let statuses = new Map<string, string>();
  let marker = "";
  const ctx = extensionContextFixture({
    model: modelFixture({
      id: "model",
      provider: "provider",
      reasoning: true,
      contextWindow: 200_000,
    }),
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getCwd: () => "/project",
      getLeafId: () => null,
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
  });
  const config = defaultResolvedCosmicUiConfig();
  const snapshot = { contributions: [] };
  const projection = {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    gitStatus: undefined,
    pullRequestNumber: undefined,
    pullRequestUrl: undefined,
    homeDirectory: undefined,
  };
  const component = createFooterComponent({
    pi: extensionApiFixture({ getThinkingLevel: () => thinking }),
    ctx: () => ctx,
    footerData: footerDataFixture({
      getGitBranch: () => branch,
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses,
    }),
    theme: { fg: (_color, value) => `${marker}${value}` },
    registry: { snapshot: () => snapshot },
    config: () => config,
    projection: () => projection,
  });
  const text = (width = 120) => Arr.join(component.render(width), "\n");

  expect(text()).toContain("thinking off");
  thinking = "high";
  expect(text()).toContain("high");
  branch = "feature";
  expect(text()).toContain("⎇ feature");
  statuses = new Map([["probe", "probe ready"]]);
  expect(text()).toContain("probe ready");
  expect(text(40)).toBe(text(40));
  for (const line of component.render(8)) expect(visibleWidth(line)).toBeLessThanOrEqual(8);

  // Pi invalidates every component when the theme changes.
  marker = "#";
  component.invalidate();
  expect(text()).toContain("#⎇ feature");
});

it.each([
  ["", 4],
  ["plain", 5],
  ["⌂ café", 6],
  ["漢字", 4],
  ["\x1b[31mred\x1b[39m", 3],
  ["tab\tx", 7],
] as const)("keeps %j unchanged when it fits %d columns", (text, width) => {
  expect(clipToWidth(text, width)).toBe(text);
  expect(clipToWidth(text, width, "")).toBe(text);
});

it.each([
  ["plain", 4, "pla…", "plai"],
  ["⌂ café", 5, "⌂ ca…", "⌂ caf"],
  ["漢字", 3, "漢…", "漢"],
  ["\x1b[31mred\x1b[39m", 2, "r…", "re"],
  ["\x1b[31m\x1b[39m", 0, "", ""],
  ["text", -1, "", ""],
] as const)("clips %j to %d columns", (text, width, marked, unmarked) => {
  expect(stripTerminalSequences(clipToWidth(text, width))).toBe(marked);
  expect(stripTerminalSequences(clipToWidth(text, width, ""))).toBe(unmarked);
});
