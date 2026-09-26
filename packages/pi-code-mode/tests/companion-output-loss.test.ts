import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mcpCodeModeError } from "pi-mcp/code-mode";
import { executeHarness, textOf } from "./support/execute.ts";
import { backgroundTaskProvider, mcpProvider } from "./support/providers.ts";

const expectCompletedLoss = (text: string) => {
  expect(text).toContain("handled");
  expect(text).toContain("not delivered in full");
  expect(text).toContain("Do not replay completed or uncertain operations");
  expect(text).toContain('"completed":1');
  expect(text).toContain('"unknown":0');
};

describe("companion output loss without presentation evidence", () => {
  it.effect.each([
    { action: "list", text: "x".repeat(10_000) },
    { action: "list", text: 42 },
    { action: "status", text: "wrong action" },
  ])("reports consumer rejection of a legacy background reply: $action", (output) =>
    Effect.gen(function* () {
      let dispatched = 0;
      // Older companions return output without supplying the optional presentation callback.
      const events = backgroundTaskProvider(() => {
        dispatched++;
        return Promise.resolve(output);
      });
      const { run } = executeHarness({
        events,
        runPromise: Effect.runPromiseWith(yield* Effect.context<never>()),
        cwd: "/workspace",
        config: { maxCumulativeChildOutputBytes: 1_000 },
      });
      const result = yield* Effect.promise(() =>
        run(
          'try { await tools.session.backgroundTask({action:"list"}); } catch {} return "handled";',
        ),
      );
      expectCompletedLoss(textOf(result));
      expect(dispatched).toBe(1);
    }),
  );

  it.effect.each(["stale", "cancelled"] as const)(
    "preserves completed MCP work when %s suppresses provider publication",
    (kind) =>
      Effect.gen(function* () {
        let dispatched = 0;
        const events = mcpProvider(() => {
          dispatched++;
          return Promise.reject(mcpCodeModeError(kind, "completed"));
        });
        const { run } = executeHarness({
          events,
          runPromise: Effect.runPromiseWith(yield* Effect.context<never>()),
          cwd: "/workspace",
        });
        const result = yield* Effect.promise(() =>
          run('try { await tools.mcp.request({action:"status"}); } catch {} return "handled";'),
        );
        expectCompletedLoss(textOf(result));
        expect(dispatched).toBe(1);
      }),
  );
});
