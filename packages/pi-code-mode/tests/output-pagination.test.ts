import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodeModeSuccess } from "../src/boundary/codemode-runtime.ts";
import type { ResultArtifact } from "../src/results/model.ts";
import { projectResultPage } from "../src/results/projection.ts";
import type { ResultsContract } from "../src/results/service.ts";
import {
  ExecutionReceiptsSchema,
  projectInitialReceipts,
  type ExecutionReceipts,
} from "../src/tools/execution-receipts.ts";
import { callEntryDetails, formatCodeModeSuccess } from "../src/tools/format.ts";
import { utf8ByteLength } from "../src/tools/limits.ts";
import { makeResultResponse } from "../src/tools/result-response.ts";

const PageSchema = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
    kind: Schema.Literals(["output", "failure-receipt"]),
    offset: Schema.Natural,
    next: Schema.NullOr(Schema.Natural),
    total: Schema.Natural,
    text: Schema.String,
    recovery: Schema.optionalKey(
      Schema.Struct({
        action: Schema.Literal("result.read"),
        id: Schema.String,
        offset: Schema.Natural,
      }),
    ),
    receipts: Schema.optionalKey(Schema.Unknown),
  }),
);
const parsePage = Schema.decodeUnknownSync(PageSchema);

const emptyReceipts: ExecutionReceipts = {
  total: 0,
  completed: 0,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: [],
};

const readReceipts = (count: number): ExecutionReceipts => ({
  total: count,
  completed: count,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: Array.from({ length: count }, (_, id) => ({
    id,
    tool: id % 2 === 0 ? "pi.read" : "pi.grep",
    target: `/workspace/${"long-directory/".repeat(8)}file-${id}.ts`,
    certainty: "completed",
    delivery: "delivered",
    isError: false,
  })),
});

const writeReceipts: ExecutionReceipts = {
  total: 1,
  completed: 1,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: [
    {
      id: 0,
      tool: "pi.write",
      target: "/workspace/file.ts",
      certainty: "completed",
      delivery: "delivered",
      isError: false,
    },
  ],
};

const execute = (
  result: CodeModeSuccess,
  maxBytes: number,
  receipts: ExecutionReceipts = emptyReceipts,
) =>
  Effect.gen(function* () {
    let stored: ResultArtifact | undefined;
    const results: ResultsContract = {
      put: (text, outcome, kind = "output") =>
        Effect.sync(() => {
          stored = { id: "cm-preview-1", text, outcome, kind, cost: 0 };
          return stored.id;
        }),
      get: () => Effect.succeed(stored),
      clear: Effect.void,
    };
    const exact = formatCodeModeSuccess(result);
    const response = makeResultResponse({
      maxBytes,
      results,
      run: Effect.runPromise,
      current: () => true,
      aborted: () => false,
      capture: () => ({ status: "captured", text: exact }),
      settle: () => callEntryDetails([]),
      receipts: () => receipts,
      nestedOutputLost: () => false,
      retain: () => undefined,
    });
    const delivered = yield* Effect.promise(() => response.success(result));
    return {
      delivered,
      exact,
      stored,
      text: delivered.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    };
  });

const reassemble = (artifact: ResultArtifact, first: string, maxBytes: number): string => {
  let page = parsePage(first);
  let text = page.text;
  for (let count = 0; page.next !== null && count < 10_000; count++) {
    const projected = projectResultPage(artifact, page.next, 30_000, maxBytes);
    expect(projected.presentation.status).toBe("page");
    page = parsePage(projected.text);
    text += page.text;
  }
  expect(page.next).toBeNull();
  return text;
};

describe("initial retained-output pages", () => {
  it.effect.each([
    {
      name: "text and logs",
      result: {
        ok: true,
        value: '😀 quoted "text"\\line\n'.repeat(200),
        logs: ["first log", "é".repeat(200)],
        truncated: true,
      } satisfies CodeModeSuccess,
    },
    {
      name: "structured JSON and logs",
      result: {
        ok: true,
        value: {
          items: Array.from({ length: 300 }, (_, index) => ({ index, value: `v${index}` })),
        },
        logs: ["structured tail"],
        truncated: true,
      } satisfies CodeModeSuccess,
    },
  ])("reassembles exact captured $name from the initial page and result.read pages", ({ result }) =>
    Effect.gen(function* () {
      const maxBytes = 600;
      const { delivered, exact, stored, text } = yield* execute(result, maxBytes);
      expect(stored).toBeDefined();
      if (stored === undefined) throw new Error("Expected retained output");
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(maxBytes);
      const first = parsePage(text);
      expect(first).toMatchObject({
        id: stored.id,
        outcome: "succeeded",
        kind: "output",
        offset: 0,
        total: exact.length,
      });
      expect(first.next).not.toBeNull();
      expect(first.recovery).toEqual({
        action: "result.read",
        id: stored.id,
        offset: first.next,
      });
      expect(delivered.details.initialPreview).toMatchObject({
        status: "page",
        id: stored.id,
        originalOutcome: "succeeded",
        kind: "output",
        offset: 0,
        end: first.text.length,
        next: first.next,
        total: exact.length,
        receiptMode: "none",
      });
      expect(reassemble(stored, text, maxBytes)).toBe(exact);
    }),
  );

  it.effect(
    "reduces only complete read-only receipts so a receipt-heavy preview still carries output",
    () =>
      Effect.gen(function* () {
        const receipts = readReceipts(128);
        const { delivered, text } = yield* execute(
          { ok: true, value: "useful output ".repeat(500), truncated: true },
          500,
          receipts,
        );
        const page = parsePage(text);
        expect(page.text.length).toBeGreaterThan(0);
        expect(page.receipts).toEqual({ total: 128, completed: 128 });
        expect(page.receipts).not.toHaveProperty("calls");
        expect(delivered.details.initialPreview?.receiptMode).toBe("read-only");
        expect(delivered.details.executionReceipts).toBe(receipts);
      }),
  );

  it("reduces no incomplete, uncertain, failed, mutating, shell, MCP, or background receipt", () => {
    const completeRead = readReceipts(1);
    const variants: ExecutionReceipts[] = [
      { ...emptyReceipts, calls: writeReceipts.calls },
      { ...completeRead, omitted: 1 },
      {
        ...readReceipts(2),
        calls: [readReceipts(2).calls[0]!, { ...readReceipts(2).calls[1]!, id: 0 }],
      },
      {
        ...completeRead,
        calls: [{ ...completeRead.calls[0]!, certainty: "unknown" }],
        completed: 0,
        unknown: 1,
      },
      { ...completeRead, calls: [{ ...completeRead.calls[0]!, delivery: "not-delivered" }] },
      { ...completeRead, calls: [{ ...completeRead.calls[0]!, isError: true }] },
      {
        ...completeRead,
        calls: completeRead.calls.map(({ isError: _isError, ...call }) => call),
      },
      ...["pi.write", "pi.edit", "pi.bash", "mcp.request", "session.backgroundTask"].map(
        (tool): ExecutionReceipts => ({
          ...completeRead,
          calls: [{ ...completeRead.calls[0]!, tool }],
        }),
      ),
    ];
    for (const receipts of variants)
      expect(projectInitialReceipts(receipts).receiptMode).toBe("full");
  });

  it.effect("keeps full risky receipts in the initial envelope when they fit", () =>
    Effect.gen(function* () {
      const { delivered, text } = yield* execute(
        { ok: true, value: "output ".repeat(500), truncated: true },
        1_200,
        writeReceipts,
      );
      const page = parsePage(text);
      expect(page.text.length).toBeGreaterThan(0);
      expect(yield* Schema.decodeUnknownEffect(ExecutionReceiptsSchema)(page.receipts)).toEqual(
        writeReceipts,
      );
      expect(delivered.details.initialPreview?.receiptMode).toBe("full");
    }),
  );

  it.effect(
    "uses bounded plain recovery without a cursor when full receipt metadata cannot fit",
    () =>
      Effect.gen(function* () {
        const receipts: ExecutionReceipts = {
          ...writeReceipts,
          calls: writeReceipts.calls.map((call) => ({ ...call, target: "x".repeat(512) })),
        };
        const { delivered, text } = yield* execute(
          { ok: true, value: "😀".repeat(1_000), truncated: true },
          120,
          receipts,
        );
        expect(utf8ByteLength(text)).toBeLessThanOrEqual(120);
        expect(delivered.details.resultId).toBe("cm-preview-1");
        expect(delivered.details.initialPreview).toBeUndefined();
        expect(text).not.toContain('"next"');
        expect(() => JSON.parse(text)).toThrow();
      }),
  );
});
