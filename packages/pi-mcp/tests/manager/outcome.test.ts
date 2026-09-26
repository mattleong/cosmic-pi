import { expect, it } from "vitest";
import type { McpMetadataSummary } from "../../src/discovery/model.ts";
import { readableMcpOutcome, successfulMcpOutcome } from "../../src/manager/controller.ts";

const summary = (
  tools: number,
  supported = true,
  diagnostics: McpMetadataSummary["diagnostics"] = [],
): McpMetadataSummary => ({
  server: "demo",
  revision: 1,
  tools,
  resources: 0,
  templates: 0,
  prompts: 0,
  support: { tools: supported, resources: true, templates: true, prompts: true },
  diagnostics,
});
const refresh = (...args: Parameters<typeof summary>) =>
  successfulMcpOutcome("refresh", summary(...args));

it.each([0, 1, 125])("reports a supported tools count: %s", (tools) => {
  expect(refresh(tools)).toMatch(new RegExp(`\\b${tools}\\b`));
});
it("does not describe an unsupported tools catalog as a loaded empty catalog", () => {
  const text = refresh(0, false, [{ family: "tools", reason: "rpc-method-not-found" }]);
  expect(text).toMatch(/unavailable/i);
  expect(text).not.toMatch(/\b0\b/);
});
it("keeps unavailable non-tools catalogs visible alongside a successful tools count", () => {
  const text = refresh(12, true, [{ family: "resources", reason: "rpc-method-not-found" }]);
  expect(text).toMatch(/\b12\b/);
  expect(text).toMatch(/unavailable/i);
});
it("never echoes gateway reply data or counts outside refresh feedback", () => {
  for (const isError of [false, true]) {
    const data = { text: "private-secret", result: { tools: 125, support: { tools: true } } };
    const text = readableMcpOutcome({
      action: "refresh",
      outcome: "completed",
      isError,
      data,
      notices: [],
    });
    expect(text).not.toMatch(/private-secret|125/);
  }
  expect(successfulMcpOutcome("connect", summary(125))).toBe(successfulMcpOutcome("connect"));
});
