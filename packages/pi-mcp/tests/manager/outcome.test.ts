import { expect, it } from "vitest";
import type * as Schema from "effect/Schema";
import { readableMcpOutcome } from "../../src/manager/controller.ts";

const refresh = (data: Schema.Json, isError = false) =>
  readableMcpOutcome({
    action: "refresh",
    outcome: "completed",
    isError,
    data,
    notices: [],
  });

it.each([0, 1, 125])("reports a validated supported tools count: %s", (tools) => {
  expect(refresh({ result: { tools, support: { tools: true } } })).toMatch(
    new RegExp(`\\b${tools}\\b`),
  );
});
it("does not describe an unsupported tools catalog as a loaded empty catalog", () => {
  const text = refresh({
    result: { tools: 0, support: { tools: false }, diagnostics: [{ family: "tools" }] },
  });
  expect(text).toMatch(/unavailable/i);
  expect(text).not.toMatch(/\b0\b/);
});
it("keeps unavailable non-tools catalogs visible alongside a successful tools count", () => {
  const text = refresh({
    result: { tools: 12, support: { tools: true }, diagnostics: [{ family: "resources" }] },
  });
  expect(text).toMatch(/\b12\b/);
  expect(text).toMatch(/unavailable/i);
});
it("omits unvalidated counts, raw values, and error-result counts from success feedback", () => {
  for (const data of [
    null,
    { text: "private-secret" },
    { result: { tools: "private-secret", support: { tools: true } } },
    { result: { tools: -987, support: { tools: true } } },
  ]) {
    const text = refresh(data);
    expect(text).not.toMatch(/private-secret|987/);
  }
  expect(refresh({ result: { tools: 125, support: { tools: true } } }, true)).not.toMatch(
    /\b125\b/,
  );
});
it("keeps Connect feedback separate from discovery counts", () => {
  const reply = { action: "connect", outcome: "completed" as const, isError: false, notices: [] };
  expect(
    readableMcpOutcome({ ...reply, data: { result: { tools: 125, support: { tools: true } } } }),
  ).toBe(readableMcpOutcome({ ...reply, data: null }));
});
