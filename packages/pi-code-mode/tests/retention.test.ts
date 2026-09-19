import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { CodeModeResults } from "../src/results/service.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import {
  applyRetainedCodeModeFailureDetails,
  makeFailureDetailsRetention,
} from "../src/tools/retention.ts";

const details = (tool: string) => ({
  toolCalls: [{ tool, status: "error" as const, activity: `Call ${tool}` }],
  counts: {
    total: 1,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
  },
});

describe("failure details retention", () => {
  it.effect(
    "suppresses a retained page when caller abort wins after the session Promise settles",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const id = yield* results.put("PRIVATE_PAGE", "failed", "failure-receipt");
        expect(id).toBeDefined();
        const caller = new AbortController();
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const execute = makeCodeModeToolExecute({
          results,
          isCurrent: () => true,
          getState: () => codeModeStateFixture(),
          runInSession: (effect) =>
            runPromise(effect).then((value) => {
              caller.abort();
              return value;
            }),
          definitions: nestedToolDefinitionsFixture({}),
          events: createEventBus(),
          sessionId: "retention-race",
        });
        const result = yield* Effect.promise(() =>
          execute(
            "read",
            { action: "result.read", id: id! },
            caller.signal,
            undefined,
            extensionContextFixture({}),
          ),
        );
        expect(result.details).toMatchObject({ cancelled: true });
        expect(result.details.resultRead).toBeUndefined();
        const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          result,
        );
        expect(serialized).not.toContain("PRIVATE_PAGE");
        expect(serialized).not.toContain(id!);
        expect((yield* results.get(id!))?.outcome).toBe("failed");
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );
  it("reattaches only owned thrown-error details and consumes them once", () => {
    const retention = makeFailureDetailsRetention();
    const original = details("pi.bash");
    retention.retain("owned", original);
    retention.retain("sibling", original);
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "read",
        toolCallId: "owned",
        isError: true,
      }),
    ).toBeUndefined();
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "code_mode",
        toolCallId: "owned",
        isError: false,
      }),
    ).toBeUndefined();
    original.toolCalls[0]!.tool = "mutated-input";
    original.counts.total = 99;
    const consumed = applyRetainedCodeModeFailureDetails(retention, {
      toolName: "code_mode",
      toolCallId: "owned",
      isError: true,
    })?.details;
    expect(consumed?.toolCalls[0]?.tool).toBe("pi.bash");
    expect(consumed?.counts?.total).toBe(1);
    Reflect.set(consumed?.toolCalls[0] ?? {}, "tool", "mutated-output");
    Reflect.set(consumed?.counts ?? {}, "total", 77);
    expect(retention.consume("sibling")?.toolCalls[0]?.tool).toBe("pi.bash");
    expect(retention.consume("owned")).toBeUndefined();
  });

  it("detaches semantic failure provenance and its recovery notices", () => {
    const retention = makeFailureDetailsRetention();
    const failurePresentation = {
      version: 1 as const,
      tool: "bash" as const,
      evidence: { code: "shell-exit", cause: "Exited with code 1", coverage: "complete" as const },
      notices: [{ kind: "recovery" as const, text: "Read retained output." }],
    };
    retention.retain("owned", { ...details("pi.bash"), failurePresentation });
    failurePresentation.evidence.cause = "mutated";
    failurePresentation.notices[0]!.text = "mutated";
    const value = retention.consume("owned")?.failurePresentation;
    expect(value?.evidence.cause).toBe("Exited with code 1");
    expect(value?.notices[0]?.text).toBe("Read retained output.");
    Reflect.set(value?.evidence ?? {}, "cause", "replaced");
    expect(value?.evidence.cause).toBe("Exited with code 1");
  });

  it("evicts the oldest entry at capacity", () => {
    const retention = makeFailureDetailsRetention(2);
    retention.retain("a", details("a"));
    retention.retain("b", details("b"));
    retention.retain("c", details("c"));
    expect(retention.consume("a")).toBeUndefined();
    expect(retention.consume("b")?.toolCalls[0]?.tool).toBe("b");
    expect(retention.consume("c")?.toolCalls[0]?.tool).toBe("c");
  });
});
