import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeQuery,
} from "pi-mcp/code-mode";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import type { ExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { utf8ByteLength } from "../src/tools/limits.ts";
import { composeRecoveryResponse } from "../src/tools/recovery-response.ts";
import { makeResultResponse } from "../src/tools/result-response.ts";
import type { ResultsContract } from "../src/results/service.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const manyReceipts = (): ExecutionReceipts => ({
  total: 300,
  completed: 299,
  unknown: 1,
  notSent: 0,
  omitted: 44,
  calls: Array.from({ length: 256 }, (_, id) => ({
    id,
    tool: "pi.write",
    target: `target-${id}/${"x".repeat(490)}`,
    certainty: id === 255 ? "unknown" : "completed",
    delivery: id === 255 ? "not-delivered" : "delivered",
    isError: false,
    ...(id === 255 && { recoveryId: "provider-recovery" }),
  })),
});

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("\n");

const expectSafety = (text: string) => {
  expect(text).toContain("not delivered in full");
  expect(text).toContain("Do not replay completed or uncertain operations");
  expect(text).toContain("not operation success");
};

describe("agent-visible nested loss", () => {
  it.effect.each([0, 20])(
    "reports a completed write even with %i child bytes available",
    (budget) =>
      Effect.gen(function* () {
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        let writes = 0;
        const execute = makeCodeModeToolExecute({
          isCurrent: () => true,
          getState: () => codeModeStateFixture({ maxCumulativeChildOutputBytes: budget }),
          events: createEventBus(),
          sessionId: "write-loss",
          runInSession: (effect) => run(effect),
          definitions: nestedToolDefinitionsFixture({
            write: {
              execute: () => {
                writes++;
                return Promise.resolve({
                  content: [{ type: "text", text: "x".repeat(400) }],
                  details: undefined,
                });
              },
            },
          }),
        });
        // Missing UI context must not suppress execution-owned loss evidence.
        const result = yield* Effect.promise(() =>
          execute(
            "write",
            {
              code: 'try { return await tools.pi.write({path:"fixture",content:"updated"}); } catch(e) { return e.message; }',
            },
            undefined,
            undefined,
            extensionContextFixture({}),
          ),
        );
        expectSafety(textOf(result));
        expect(textOf(result)).toContain('"completed":1');
        expect(textOf(result)).toContain('"unknown":0');
        expect(textOf(result)).not.toContain("retention-limit");
        expect(result.details.resultId).toBeUndefined();
        expect(writes).toBe(1);
      }),
  );

  it.effect("keeps fully delivered, intentionally handled native errors unchanged", () =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const execute = makeCodeModeToolExecute({
        isCurrent: () => true,
        getState: () => codeModeStateFixture(),
        events: createEventBus(),
        sessionId: "handled-error",
        runInSession: (effect) => run(effect),
        definitions: nestedToolDefinitionsFixture({
          read: { execute: () => Promise.reject(new Error("Expected read failure")) },
        }),
      });
      const result = yield* Effect.promise(() =>
        execute(
          "handled",
          {
            code: 'try { await tools.pi.read({path:"fixture"}); } catch {} return "handled";',
          },
          undefined,
          undefined,
          extensionContextFixture({ cwd: "/workspace" }),
        ),
      );
      expect(textOf(result)).toBe("handled");
    }),
  );

  it.effect("reports MCP projection loss even when its typed refusal fits the child budget", () =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const events = createEventBus();
      let dispatched = 0;
      events.on(MCP_CODE_MODE_QUERY, (request) =>
        normalizeMcpCodeModeQuery(request)?.respond({
          version: MCP_CODE_MODE_VERSION,
          sessionId: "loss",
          execute: () => {
            dispatched++;
            return Promise.resolve({
              action: "status",
              outcome: "completed",
              isError: false,
              data: "x".repeat(10_000),
              notices: [],
            });
          },
        }),
      );
      const execute = makeCodeModeToolExecute({
        isCurrent: () => true,
        getState: () => codeModeStateFixture({ maxCumulativeChildOutputBytes: 1_000 }),
        runInSession: (effect) => run(effect),
        definitions: nestedToolDefinitionsFixture({}),
        events,
        sessionId: "loss",
      });
      const result = yield* Effect.promise(() =>
        execute(
          "mcp",
          {
            code: 'try { await tools.mcp.request({action:"status"}); } catch {} return "handled";',
          },
          undefined,
          undefined,
          extensionContextFixture({ cwd: "/workspace" }),
        ),
      );
      expectSafety(textOf(result));
      expect(textOf(result)).toContain('"completed":1');
      expect(dispatched).toBe(1);
    }),
  );
});

describe("diagnostic and receipt byte allocation", () => {
  it("preserves a short root diagnostic, aggregate certainty and risky recovery IDs before bulk rows", () => {
    const result = composeRecoveryResponse({
      raw: "ROOT_DIAGNOSTIC",
      recovery: "No retained result is available.",
      receipts: manyReceipts(),
      nestedOutputLost: true,
      maxBytes: 3_000,
    });
    expectSafety(result.text);
    expect(result.text).toContain("ROOT_DIAGNOSTIC");
    expect(result.text).toContain('"total":300');
    expect(result.text).toContain('"unknown":1');
    expect(result.text).toContain('"omitted":44');
    expect(result.text).toContain("provider-recovery");
    expect(result.text).toContain("omitted from this response");
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(3_000);
  });

  it("reserves recovery facts even when the root diagnostic is itself huge", () => {
    const result = composeRecoveryResponse({
      raw: `ROOT_DIAGNOSTIC ${"🙂".repeat(50_000)}`,
      recovery: "Read retained failure receipt cm-test.",
      receipts: manyReceipts(),
      nestedOutputLost: true,
      maxBytes: 3_000,
    });
    expectSafety(result.text);
    expect(result.text).toContain("ROOT_DIAGNOSTIC");
    expect(result.text).toContain("cm-test");
    expect(result.text).not.toContain("�");
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(3_000);
  });

  it.each([0, 1, 2, 10, 63, 120, 500])(
    "honors a %i-byte cap without invented cursors",
    (maxBytes) => {
      const result = composeRecoveryResponse({
        raw: "🙂ROOT_DIAGNOSTIC",
        recovery: "Retained output unavailable.",
        receipts: manyReceipts(),
        nestedOutputLost: true,
        maxBytes,
      });
      expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(maxBytes);
      expect(result.text).not.toContain("�");
      expect(result.text).not.toContain('"next"');
    },
  );

  it.effect.each(["absent", "refused", "retained"] as const)(
    "preserves the thrown root diagnostic when retention is %s",
    (retention) =>
      Effect.gen(function* () {
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        let stored = "";
        const results: ResultsContract = {
          put: (text) =>
            Effect.sync(() => {
              stored = text;
              return retention === "retained" ? "cm-failure" : undefined;
            }),
          get: () => Effect.succeed(undefined),
          clear: Effect.void,
        };
        const response = makeResultResponse({
          maxBytes: 3_000,
          results: retention === "absent" ? undefined : results,
          run,
          current: () => true,
          aborted: () => false,
          capture: () => ({ status: "captured", text: "ROOT_DIAGNOSTIC" }),
          settle: () => callEntryDetails([]),
          receipts: manyReceipts,
          nestedOutputLost: () => false,
          retain: () => undefined,
        });
        const failure = yield* Effect.tryPromise(() => response.failure("ROOT_DIAGNOSTIC")).pipe(
          Effect.flip,
        );
        expect(failure.cause).toBeInstanceOf(Error);
        if (!(failure.cause instanceof Error)) throw new Error("Expected host failure");
        const text = failure.cause.message;
        expect(text).toContain("ROOT_DIAGNOSTIC");
        expect(text).toContain("Do not replay");
        expect(text).toContain('"unknown":1');
        expect(utf8ByteLength(text)).toBeLessThanOrEqual(3_000);
        if (retention === "retained") {
          expect(text).toContain("cm-failure");
          expect(stored).toContain("ROOT_DIAGNOSTIC");
          expect(stored).toContain("target-255");
        }
      }),
  );

  it.effect.each([false, true])(
    "retains displaced output without replacing host-loss warnings, runtime truncation=%s",
    (runtimeTruncated) =>
      Effect.gen(function* () {
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        const original = "original output".repeat(runtimeTruncated ? 1_000 : 190);
        let stored = "";
        const results: ResultsContract = {
          put: (text) =>
            Effect.sync(() => {
              stored = text;
              return "cm-output";
            }),
          get: () => Effect.succeed(undefined),
          clear: Effect.void,
        };
        const response = makeResultResponse({
          maxBytes: 3_000,
          results,
          run,
          current: () => true,
          aborted: () => false,
          capture: () => ({ status: "captured", text: original }),
          settle: () => callEntryDetails([]),
          receipts: manyReceipts,
          nestedOutputLost: () => true,
          retain: () => undefined,
        });
        const result = yield* Effect.promise(() =>
          response.success({
            ok: true,
            value: runtimeTruncated ? "preview" : original,
            truncated: runtimeTruncated,
          }),
        );
        expectSafety(textOf(result));
        expect(textOf(result)).toContain("cm-output");
        expect(result.details.initialPreview).toBeUndefined();
        expect(result.details.truncated).toBe(true);
        expect(stored).toBe(original);
      }),
  );
});
