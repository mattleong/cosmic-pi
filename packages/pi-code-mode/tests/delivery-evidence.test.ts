import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderCompactChildren } from "pi-code-previews";
import { COMPLETE_LEDGER, deliveryIssues, ledgerDetails, summarize } from "./support/compact.ts";
import { executeProgram } from "../src/engine/execute.ts";
import { childFrame, executeHarness, programProcessFixture } from "./support/execute.ts";
import { mcpProvider } from "./support/providers.ts";

describe("program delivery evidence", () => {
  it.effect(
    "records a completed call whose result the exited program never received without changing its outcome",
    () =>
      Effect.gen(function* () {
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const replyStarted = yield* Deferred.make<void>();
        const events = mcpProvider(() =>
          Promise.resolve({
            action: "status" as const,
            outcome: "completed" as const,
            isError: false,
            data: null,
            notices: [],
          }),
        );
        let released = 0;
        const h = executeHarness({
          events,
          runPromise,
          retainFailureDetails: true,
          executeCodeMode: (options) =>
            executeProgram({
              ...options,
              openProcess: (processOptions) =>
                Effect.acquireRelease(
                  Effect.succeed(
                    programProcessFixture({
                      stdout: Stream.make(
                        childFrame({
                          type: "call",
                          seq: 0,
                          path: ["mcp", "request"],
                          args: [{ action: "status" }],
                        }),
                      ).pipe(
                        Stream.concat(
                          Stream.fromEffect(Deferred.await(replyStarted)).pipe(Stream.drain),
                        ),
                      ),
                      write: (bytes) => {
                        const frame = new TextDecoder().decode(bytes.subarray(4));
                        if (!frame.includes('"type":"reply"')) return Effect.void;
                        // Adapter settlement precedes delivery. EOF then cancels the stalled
                        // reply, not the completed operation, without any post-EOF tool grace.
                        return Deferred.succeed(replyStarted, undefined).pipe(
                          Effect.andThen(Effect.never),
                        );
                      },
                    }),
                  ),
                  () =>
                    Effect.sync(() => {
                      released++;
                      processOptions.onCleanup(true);
                    }),
                ),
            }),
        });
        const exited = yield* Effect.promise(() =>
          h.run("unused").then(
            () => expect.unreachable(),
            (error: Error) => error.message,
          ),
        );
        expect(exited).toContain("exited before returning a result");
        expect(exited).toContain("Do not replay completed or uncertain operations");
        const details = h.retention.consume("call")!;
        const receipt = details.toolCalls[0]!.compact!;
        expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
        expect(deliveryIssues(receipt.issues)).toHaveLength(1);
        expect(details.executionReceipts).toMatchObject({ total: 1, completed: 1, unknown: 0 });
        expect(details.executionReceipts?.calls[0]).toMatchObject({
          certainty: "completed",
          delivery: "not-delivered",
        });
        expect(released).toBe(1);
      }),
  );

  it("keeps one delivery explanation on each retained call", () => {
    const { calls, details } = ledgerDetails(
      Array.from({ length: 36 }, () => ({
        tool: "pi.read",
        summary: { subject: "same file", outcome: "success" as const },
      })),
      { status: "error", deliveryFailures: 2 },
    );
    for (const call of calls) expect(deliveryIssues(call.compact?.issues)).toHaveLength(1);
    // Delivery loss never changes the operation outcome the ledger counts.
    expect(details.compactAttention).toEqual(COMPLETE_LEDGER);
    const summary = summarize(details)!;
    expect(summary.outcome).toBe("warning");
    expect(summary.issues).toEqual([]);
    expect(summary.children?.total).toBe(36);
    expect(summary.children?.entries).toHaveLength(details.toolCalls.length);
    expect(summary.children?.entries.every((child) => child.status === "error")).toBe(true);
    const expanded = renderCompactChildren(summary.children, plainTheme, 200, {
      layout: "flat",
      all: true,
    }).join("\n");
    for (const child of summary.children!.entries) {
      const detail = deliveryIssues(child.issues)[0]!.detail!;
      expect(expanded.split(detail)).toHaveLength(2);
    }
  });

  it("keeps the delivery issue when the receipt is already at its issue bound", () => {
    const issues = Array.from({ length: 16 }, (_, id) => ({
      severity: "info" as const,
      code: "page",
      message: `Existing page ${id}`,
    }));
    const { calls } = ledgerDetails(
      [{ tool: "pi.read", summary: { subject: "file", outcome: "success", issues } }],
      { status: "error", deliveryFailures: 1 },
    );
    const receipt = calls[0]!.compact!;
    expect(receipt.deliveryFailed).toBe(true);
    expect(receipt.issues).toHaveLength(16);
    expect(deliveryIssues(receipt.issues)).toHaveLength(1);
  });
});
