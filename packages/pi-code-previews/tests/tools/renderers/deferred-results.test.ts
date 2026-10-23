import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { afterEach, beforeEach, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../../testing";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../../src/application/capability";
import { builtinRenderers, textResult } from "../../support/render";

let queued: Array<() => void> = [];

beforeEach(() => {
  queued = [];
  applyPresentationSettings({ toolCallTiming: false, toolCallCollapsedStyle: "preview" });
  installCodePreviewSessionCapability({
    run: () => Promise.reject(new Error("not used")),
    defer: (task) => {
      queued.push(task);
      return () => {
        queued = Arr.filter(queued, (entry) => entry !== task);
      };
    },
    schedule: () => () => undefined,
  });
});
afterEach(() => clearCodePreviewSessionCapability());

const lines = (line: (index: number) => string) =>
  Arr.join(
    Array.from({ length: 1_000 }, (_, index) => line(index)),
    "\n",
  );

for (const { name, args, output, last } of [
  {
    name: "read",
    args: { path: "/project/a.txt" },
    output: lines((index) => `line ${index}`),
    last: "line 999",
  },
  {
    name: "grep",
    args: { pattern: "match", path: "/project" },
    output: lines((index) => `a.txt:${index + 1}: match ${index}`),
    last: "match 999",
  },
] as const)
  test(`a large expanded ${name} result draws after deferred work while its collapsed preview draws at once`, () => {
    const renderers = builtinRenderers(name);
    assert.ok(renderers);
    const harness = createToolPresentationHarness(renderers);
    const text = () => Arr.join(harness.render(120), "\n");
    harness.call(args);
    harness.result(textResult(output));
    assert.match(text(), /\b0\b/u);
    assert.equal(queued.length, 0);

    harness.result(textResult(output), { expanded: true });
    assert.equal(Fn.pipe(text(), Str.includes(last)), false);
    for (const task of queued.splice(0)) task();
    assert.ok(Fn.pipe(text(), Str.includes(last)));
  });
