import assert from "node:assert/strict";
import {
  initTheme,
  type AgentToolResult,
  type ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeAll, test } from "vitest";
import { macrotask } from "pi-cosmic-core/testing";
import { hostToolRow } from "../../../testing";
import { defaultCodePreviewSettings } from "../../../src/config/defaults";
import type { CodePreviewSettings } from "../../../src/config/schema";
import { setCodePreviewSettings } from "../../../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../../../src/tools/names";
import { builtinRenderers, stripAnsi } from "../../support/render";

beforeAll(() => initTheme("dark", false));
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

type RowArguments =
  | { readonly path: string; readonly content: string }
  | {
      readonly path: string;
      readonly edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string }>;
    };

function liveRow(
  name: "write" | "edit",
  args: RowArguments,
  settings: Partial<CodePreviewSettings> = {},
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "preview",
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    ...settings,
  });
  const renderers = builtinRenderers(name);
  const row = hostToolRow(name, args, renderers, { id: `${name}-call` });
  row.setArgsComplete();
  return row;
}

const text = (row: ToolExecutionComponent) => stripAnsi(row.render(120).join("\n"));
const count = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

const result = <Details>(
  output: string,
  details: Details,
  isError = false,
): AgentToolResult<Details> & { isError: boolean } => ({
  content: [{ type: "text", text: output }],
  details,
  isError,
});

const before = `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\n`;
const content = before.replace("line 10\n", "LINE 10\n");
const overwrite = result("Successfully wrote to a.txt", {
  codePreviewBeforeWrite: { kind: "content", content: before },
});

test("a finished write shows its diff once, and its content when no diff is shown", () => {
  const row = liveRow("write", { path: "/project/a.txt", content });
  assert.match(text(row), /line 0\b/u);
  row.markExecutionStarted();
  assert.match(text(row), /line 0\b/u);
  row.updateResult(overwrite);
  const settled = text(row);
  assert.equal(count(settled, /LINE 10/gu), 1);
  assert.doesNotMatch(settled, /line 0\b/u);
  row.setExpanded(true);
  assert.match(text(row), /line 0\b/u);

  for (const withoutDiff of [
    result("EACCES: permission denied, open '/project/a.txt'", undefined, true),
    result("Successfully wrote to a.txt", {}),
    result("Successfully wrote to a.txt", { codePreviewBeforeWrite: undefined }),
  ]) {
    const other = liveRow("write", { path: "/project/a.txt", content });
    other.markExecutionStarted();
    other.updateResult(withoutDiff);
    assert.match(text(other), /line 0\b/u);
  }
});

test("a replayed diff-skip reason cannot write terminal control sequences", () => {
  const row = liveRow("write", { path: "/project/a.txt", content: "next" });
  row.updateResult(
    result("Successfully wrote to a.txt", {
      codePreviewBeforeWrite: {
        kind: "skipped",
        reason: "previous file too large\u001b]0;title\u0007",
        byteLength: 300_000,
        maxBytes: 200_000,
        sizeExceeded: true,
      },
    }),
  );
  for (const expanded of [false, true]) {
    row.setExpanded(expanded);
    assert.equal(row.render(120).join("\n").includes("\u001b]0;title"), false);
  }
});

test("NUL-containing edits cannot reuse a different proposal", () => {
  const first = { path: "/project/a.ts", edits: [{ oldText: "a\0b", newText: "c" }] };
  const next = { ...first, edits: [{ oldText: "a", newText: "b\0c" }] };
  const row = liveRow("edit", first);
  const obsolete = text(row);
  row.updateArgs(next);
  row.setArgsComplete();
  const updated = text(row);
  assert.notEqual(updated, obsolete);
  assert.equal(updated, text(liveRow("edit", next)));
  row.setExpanded(true);
  const fresh = liveRow("edit", next);
  fresh.setExpanded(true);
  assert.equal(text(row), text(fresh));
});

it.effect.each([
  {
    name: "edit",
    argsAt: (size: number): RowArguments => ({
      path: "/project/a.ts",
      edits: [{ oldText: "a", newText: "b".repeat(size) }],
    }),
  },
  {
    name: "write",
    argsAt: (size: number): RowArguments => ({ path: "/project/a.ts", content: "c".repeat(size) }),
  },
] as const)("a $name row releases the render contexts of replaced arguments", ({ name, argsAt }) =>
  Effect.gen(function* () {
    const collectGarbage = globalThis.gc;
    assert.ok(collectGarbage, "vitest.config.ts starts test workers with --expose-gc");
    let first: RowArguments | undefined = argsAt(1);
    const released = new WeakRef(first);
    const row = liveRow(name, first);
    first = undefined;
    for (let size = 2; size <= 20; size++) {
      row.updateArgs(argsAt(size));
      row.render(120);
    }
    yield* macrotask;
    collectGarbage();
    assert.equal(released.deref(), undefined);
    assert.match(text(row), /a\.ts/u);
  }),
);
