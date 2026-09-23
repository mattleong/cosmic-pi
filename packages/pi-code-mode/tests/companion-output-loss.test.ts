import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeQuery,
} from "pi-background-task/code-mode";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  mcpCodeModeError,
  normalizeMcpCodeModeQuery,
} from "pi-mcp/code-mode";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("\n");

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
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const events = createEventBus();
      let dispatched = 0;
      events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (query) =>
        normalizeBackgroundTaskCodeModeQuery(query)?.respond({
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId: "background-loss",
          // Older companions return output without supplying the optional presentation callback.
          execute: () => {
            dispatched++;
            return Promise.resolve(output);
          },
        }),
      );
      const execute = makeCodeModeToolExecute({
        isCurrent: () => true,
        getState: () => codeModeStateFixture({ maxCumulativeChildOutputBytes: 1_000 }),
        runInSession: (effect) => run(effect),
        definitions: nestedToolDefinitionsFixture({}),
        events,
        sessionId: "background-loss",
      });
      const result = yield* Effect.promise(() =>
        execute(
          "legacy",
          {
            code: 'try { await tools.session.backgroundTask({action:"list"}); } catch {} return "handled";',
          },
          undefined,
          undefined,
          extensionContextFixture({ cwd: "/workspace" }),
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
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        const events = createEventBus();
        let dispatched = 0;
        events.on(MCP_CODE_MODE_QUERY, (query) =>
          normalizeMcpCodeModeQuery(query)?.respond({
            version: MCP_CODE_MODE_VERSION,
            sessionId: "mcp-revoked",
            execute: () => {
              dispatched++;
              return Promise.reject(mcpCodeModeError(kind, "completed"));
            },
          }),
        );
        const execute = makeCodeModeToolExecute({
          isCurrent: () => true,
          getState: () => codeModeStateFixture(),
          runInSession: (effect) => run(effect),
          definitions: nestedToolDefinitionsFixture({}),
          events,
          sessionId: "mcp-revoked",
        });
        const result = yield* Effect.promise(() =>
          execute(
            "suppressed",
            {
              code: 'try { await tools.mcp.request({action:"status"}); } catch {} return "handled";',
            },
            undefined,
            undefined,
            extensionContextFixture({ cwd: "/workspace" }),
          ),
        );
        expectCompletedLoss(textOf(result));
        expect(dispatched).toBe(1);
      }),
  );
});
