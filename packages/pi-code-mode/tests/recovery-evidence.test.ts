import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";
import { CodeModeResults } from "../src/results/service.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import type { ExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { codeModeStatusResult } from "../src/tools/status.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { codeModeStatusCompactSummary } from "../src/ui/status.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const receipts: ExecutionReceipts = {
  total: 1,
  completed: 1,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: [
    { id: 0, tool: "pi.write", certainty: "completed", delivery: "delivered", isError: false },
  ],
};

const summarize = (evidence: ExecutionReceipts) =>
  codeModeCompactSummary({
    phase: "settled",
    args: { code: "return payload", intent: "Saved mutation result" },
    result: {
      content: [{ type: "text", text: "saved page" }],
      details: {
        ...callEntryDetails(
          Array.from({ length: evidence.total }, () => ({
            tool: "pi.write",
            status: "completed" as const,
          })),
        ),
        outputKind: "structured",
        truncated: true,
        resultId: "cm-replay",
        executionReceipts: evidence,
        initialPreview: {
          status: "page",
          id: "cm-replay",
          originalOutcome: "succeeded",
          kind: "output",
          offset: 0,
          end: 1,
          next: 1,
          total: 2,
          receiptMode: "full",
        },
      },
    },
    context: opaqueHostFixture({ isError: false, expanded: false }),
  });

describe("retained output safety evidence", () => {
  it("does not let a saved page hide uncertain operations or missing delivery", () => {
    expect(summarize(receipts)?.outcome).toBe("success");
    expect(
      summarize({
        ...receipts,
        completed: 0,
        unknown: 1,
        calls: [{ id: 0, tool: "pi.write", certainty: "unknown", delivery: "not-delivered" }],
      })?.outcome,
    ).toBe("uncertain");
    expect(
      summarize({
        ...receipts,
        calls: [{ ...receipts.calls[0]!, delivery: "not-delivered" }],
      })?.outcome,
    ).toBe("warning");
    expect(
      summarize({
        ...receipts,
        calls: [{ ...receipts.calls[0]!, isError: true }],
      })?.outcome,
    ).toBe("error");
  });

  it("rejects contradictory certainty counts and duplicate invocation identities", () => {
    for (const malformed of [
      { ...receipts, completed: 0, unknown: 1 },
      { ...receipts, total: 2, completed: 2, calls: [receipts.calls[0]!, receipts.calls[0]!] },
    ]) {
      const summary = summarize(malformed);
      expect(summary?.outcome).toBe("uncertain");
      expect(summary?.notices?.some((notice) => notice.code === "receipt-incomplete")).toBe(true);
    }
  });

  it("never treats cancelled or truncated status history as successful delivery", () => {
    const result = codeModeStatusResult(DEFAULT_CODE_MODE_CONFIG);
    for (const [flags, expected] of [
      [{ cancelled: true }, "cancelled"],
      [{ truncated: true }, "warning"],
      [{ cancelled: "invalid" }, undefined],
    ] as const) {
      const summary = codeModeStatusCompactSummary({
        phase: "settled",
        args: { action: "status" },
        result: { ...result, details: { ...result.details, ...flags } },
        context: opaqueHostFixture({ isError: false, expanded: false }),
      });
      expect(summary?.outcome).toBe(expected);
    }
  });

  it.effect("continues the initial page without repeating a completed mutation", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      let mutations = 0;
      const execute = makeCodeModeToolExecute({
        results,
        isCurrent: () => true,
        getState: () => codeModeStateFixture({ maxOutputBytes: 1_200, maxToolCalls: 1 }),
        runInSession: (effect) => runPromise(effect),
        definitions: nestedToolDefinitionsFixture({
          write: {
            execute: () => {
              mutations++;
              return Promise.resolve({
                content: [{ type: "text" as const, text: "saved" }],
                details: undefined,
              });
            },
          },
        }),
        events: createEventBus(),
        sessionId: "initial-page-mutation",
      });
      const ctx = extensionContextFixture({ cwd: "/project" });
      const first = yield* Effect.promise(() =>
        execute(
          "write-once",
          {
            code: 'await tools.pi.write({path:"fixture",content:"updated"}); return {payload:"🙂\\n".repeat(1000)};',
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      const Page = Schema.fromJsonString(
        Schema.Struct({
          id: Schema.String,
          next: Schema.NullOr(Schema.Natural),
          text: Schema.String,
        }),
      );
      const textOf = (result: typeof first) =>
        result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      let page = yield* Schema.decodeEffect(Page)(textOf(first));
      expect(page.next).not.toBeNull();
      let reconstructed = page.text;
      for (let attempts = 0; page.next !== null && attempts < 100; attempts++) {
        const id = page.id;
        const offset = page.next;
        const next = yield* Effect.promise(() =>
          execute(
            "continue",
            {
              action: "result.read",
              id,
              offset,
            },
            undefined,
            undefined,
            ctx,
          ),
        );
        page = yield* Schema.decodeEffect(Page)(textOf(next));
        reconstructed += page.text;
      }
      expect(page.next).toBeNull();
      const expected = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ payload: Schema.String })),
      )({ payload: "🙂\n".repeat(1000) });
      expect(reconstructed).toBe(expected);
      expect(mutations).toBe(1);
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );
});
