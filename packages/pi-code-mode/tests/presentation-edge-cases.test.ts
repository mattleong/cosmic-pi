import { createEventBus, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  isCompactAttention,
  renderCompactChildren,
  renderCompactNotices,
  selectCompactChildren,
} from "pi-code-previews";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";

const result = <Details>(text: string, details?: Details) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});
const harness = (definitions: NestedPiToolDefinitions) => {
  const state = codeModeStateFixture();
  const execute = makeCodeModeToolExecute({
    definitions,
    getState: () => state,
    isCurrent: () => true,
    events: createEventBus(),
    sessionId: "edge-cases",
    runInSession: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
  });
  return (
    code: string,
    signal?: AbortSignal,
    update?: AgentToolUpdateCallback<CodeModeToolDetails>,
  ) =>
    execute("edge-cases", { code }, signal, update, extensionContextFixture({ cwd: "/project" }));
};
const summary = (
  details: CodeModeToolDetails,
  phase: "running" | "settled" = "settled",
  text = "",
) =>
  codeModeCompactSummary({
    phase,
    args: {},
    result: result(text, details),
    context: opaqueHostFixture({ expanded: false, isError: false }),
  });

describe("presentation edge cases", () => {
  it.effect("retains only a redacted heading without changing execution arguments or output", () =>
    Effect.gen(function* () {
      const command = "echo password=PRIVATE_REVIEW_FIXTURE";
      let received: string | undefined;
      const snapshots: CodeModeToolDetails[] = [];
      const run = harness(
        nestedToolDefinitionsFixture({
          bash: {
            execute: (_id: string, input: { command: string }) => {
              received = input.command;
              return Promise.resolve(result("unchanged result"));
            },
          },
        }),
      );
      const completed = yield* Effect.promise(() =>
        run(
          'return await tools.pi.bash({command:"echo password=PRIVATE_REVIEW_FIXTURE"});',
          undefined,
          (update) => {
            if (update.details) snapshots.push(update.details);
          },
        ),
      );
      expect(received).toBe(command);
      expect(completed.content).toEqual([{ type: "text", text: "unchanged result" }]);
      const recorded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        ...snapshots,
        completed.details,
      ]);
      expect(recorded).not.toContain("PRIVATE_REVIEW_FIXTURE");
      expect(recorded).toContain("[REDACTED]");
      const projected = summary(completed.details!);
      expect(projected?.children?.entries[0]?.subject).toContain("[REDACTED]");
      expect(renderCompactChildren(projected?.children, theme, 100).join("\n")).not.toContain(
        "PRIVATE_REVIEW_FIXTURE",
      );
    }),
  );
  it.effect("preserves a completed mutation when a later call is cancelled", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let committed = false;
      let pendingSignal: AbortSignal | undefined;
      const run = harness(
        nestedToolDefinitionsFixture({
          write: {
            execute: () => {
              committed = true;
              return Promise.resolve(result("Successfully wrote 7 bytes to file"));
            },
          },
          bash: {
            execute: (_id: string, _input: { command: string }, signal?: AbortSignal) => {
              pendingSignal = signal;
              Deferred.doneUnsafe(started, Effect.void);
              return Promise.race([]);
            },
          },
        }),
      );
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      const pending = run(
        'await tools.pi.write({path:"file",content:"changed"}); await tools.pi.bash({command:"wait"});',
        controller.signal,
      );
      yield* Deferred.await(started);
      controller.abort();
      const completed = yield* Effect.promise(() => pending);
      expect(committed).toBe(true);
      expect(pendingSignal?.aborted).toBe(true);
      expect(completed.details?.cancelled).toBe(true);
      expect(completed.details?.counts).toMatchObject({ succeeded: 1, cancelled: 1 });
      expect(completed.details?.toolCalls[0]).toMatchObject({
        tool: "pi.write",
        status: "completed",
        compact: { outcome: "warning", deliveryFailed: false },
      });
      const projected = summary(
        completed.details!,
        "settled",
        completed.content[0]!.type === "text" ? completed.content[0]!.text : "",
      );
      expect(projected?.outcome).toBe("cancelled");
      // The pre-write snapshot is unavailable in nested calls, independently of cancellation.
      expect(projected?.children?.entries[0]?.status).toBe("warning");
      expect(
        projected?.notices?.some(
          (notice) => isCompactAttention(notice) && notice.text.includes("not rolled back"),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "keeps a failed parallel call visible beside running work without a duplicate parent explanation",
    () =>
      Effect.gen(function* () {
        const ready = Deferred.makeUnsafe<CodeModeToolDetails>();
        const finish = Deferred.makeUnsafe<void>();
        const run = harness(
          nestedToolDefinitionsFixture({
            read: { execute: () => Promise.resolve(result("contents")) },
            bash: {
              execute: (_id: string, input: { command: string }) =>
                input.command === "fail"
                  ? Promise.reject(new Error("Command exited with code 1"))
                  : Effect.runPromise(Deferred.await(finish).pipe(Effect.as(result("done")))),
            },
          }),
        );
        const controller = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controller.abort();
            Deferred.doneUnsafe(finish, Effect.void);
          }),
        );
        const pending = run(
          'await Promise.allSettled([tools.pi.bash({command:"fail"}), tools.pi.bash({command:"wait"}), ...[1,2,3,4,5,6].map(() => tools.pi.read({path:"file"}))]); return 1;',
          controller.signal,
          (update) => {
            const details = update.details;
            if (
              details?.counts?.failed === 1 &&
              details.counts.running === 1 &&
              details.counts.succeeded === 6
            )
              Deferred.doneUnsafe(ready, Effect.succeed(details));
          },
        );
        try {
          const details = yield* Deferred.await(ready);
          const projected = summary(details, "running");
          const children = projected!.children!;
          const selected = selectCompactChildren(children);
          expect(selected.entries.some((child) => child.status === "running")).toBe(true);
          const failure = selected.entries.find((child) => child.status === "error")!;
          expect(failure).toBeDefined();
          expect(selected.omitted).toBe(3);
          const explanation = failure.notices!.find((notice) => notice.kind === "error")!;
          expect(projected?.notices?.some((notice) => notice.text === explanation.text)).toBe(
            false,
          );
          const rendered = [
            ...renderCompactChildren(children, theme, 100),
            ...renderCompactNotices(projected?.notices, theme, 100),
          ].join("\n");
          expect(rendered.split(explanation.text)).toHaveLength(2);
          yield* Deferred.succeed(finish, undefined);
          const completed = yield* Effect.promise(() => pending);
          expect(summary(completed.details!)?.outcome).toBe("error");
          expect(completed.details?.counts).toMatchObject({ failed: 1, succeeded: 7, running: 0 });
        } finally {
          controller.abort();
          Deferred.doneUnsafe(finish, Effect.void);
          yield* Effect.promise(() => pending);
        }
      }),
  );

  it.effect("keeps Bash output recovery visible while read pagination stays expanded", () =>
    Effect.gen(function* () {
      const run = harness(
        nestedToolDefinitionsFixture({
          read: {
            execute: () =>
              Promise.resolve(
                result(
                  "body\n\n[Showing lines 1-2 of 20 (50.0KB limit). Use offset=3 to continue.]",
                  {
                    truncation: {
                      truncated: true,
                      truncatedBy: "bytes",
                      lastLinePartial: false,
                      firstLineExceedsLimit: false,
                    },
                  },
                ),
              ),
          },
          bash: {
            execute: () =>
              Promise.resolve(
                result("output", {
                  truncation: { truncated: true },
                  fullOutputPath: "/tmp/retained-output.txt",
                }),
              ),
          },
        }),
      );
      const completed = yield* Effect.promise(() =>
        run(
          'await tools.pi.read({path:"file"}); await tools.pi.bash({command:"example"}); return 1;',
        ),
      );
      const projected = summary(completed.details!);
      expect(projected?.outcome).toBe("warning");
      const children = projected!.children!;
      expect(children.entries.map((child) => child.status)).toEqual(["success", "warning"]);
      const recovery = children.entries[1]!.notices!.filter(isCompactAttention);
      expect(recovery.some((notice) => notice.text.includes("/tmp/retained-output.txt"))).toBe(
        true,
      );
      const compact = renderCompactChildren(children, theme, 100).join("\n");
      const expanded = renderCompactChildren(children, theme, 100, 0, true, true, "flat").join(
        "\n",
      );
      expect(compact).toContain("/tmp/retained-output.txt");
      expect(compact).not.toContain("offset=3");
      expect(expanded).toContain("offset=3");
      expect(expanded).toContain("/tmp/retained-output.txt");
      for (const notice of recovery)
        expect(projected?.notices?.some((parent) => parent.text === notice.text)).toBe(false);
    }),
  );
});
