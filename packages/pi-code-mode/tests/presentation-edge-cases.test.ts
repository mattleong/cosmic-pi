import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { renderCompactChildren, selectCompactChildren } from "pi-code-previews";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { executeHarness } from "./support/execute.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";

const result = <Details>(text: string, details?: Details) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const harness = (definitions: NestedPiToolDefinitions) =>
  executeHarness({ definitions, cwd: "/project" }).run;
const summary = (
  details: CodeModeToolDetails,
  phase: "running" | "settled" = "settled",
  text = "",
) =>
  codeModeCompactSummary({
    phase,
    args: {},
    result: result(text, details),
    context: opaqueFixture({ expanded: false, isError: false }),
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
        run('return await tools.pi.bash({command:"echo password=PRIVATE_REVIEW_FIXTURE"});', {
          onUpdate: (update) => {
            if (update.details) snapshots.push(update.details);
          },
        }),
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
      expect(renderCompactChildren(projected?.children, plainTheme, 100).join("\n")).not.toContain(
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
        { signal: controller.signal },
      );
      yield* Deferred.await(started);
      controller.abort();
      const completed = yield* Effect.promise(() => pending);
      expect(committed).toBe(true);
      expect(pendingSignal?.aborted).toBe(true);
      expect(completed.details?.cancelled).toBe(true);
      expect(completed.details?.counts).toMatchObject({ succeeded: 1, cancelled: 1 });
      // Nested Code Mode intentionally skips the pre-write snapshot; that is informational.
      expect(completed.details?.toolCalls[0]).toMatchObject({
        tool: "pi.write",
        status: "completed",
        compact: {
          outcome: "success",
          deliveryFailed: false,
          issues: [expect.objectContaining({ severity: "info" })],
        },
      });
      const projected = summary(
        completed.details!,
        "settled",
        completed.content[0]!.type === "text" ? completed.content[0]!.text : "",
      );
      expect(projected?.outcome).toBe("cancelled");
      expect(projected?.children?.entries.map((child) => child.status)).toEqual([
        "success",
        "cancelled",
      ]);
      expect(projected?.issues?.[0]).toMatchObject({ severity: "warning", code: "cancelled" });
      expect(projected?.issues?.every((issue) => issue.severity === "warning")).toBe(true);
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
          {
            signal: controller.signal,
            onUpdate: (update) => {
              const details = update.details;
              if (
                details?.counts?.failed === 1 &&
                details.counts.running === 1 &&
                details.counts.succeeded === 6
              )
                Deferred.doneUnsafe(ready, Effect.succeed(details));
            },
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
          const explanation = failure.issues!.find((issue) => issue.severity === "error")!;
          expect(projected?.issues).toBeUndefined();
          const rendered = renderCompactChildren(children, plainTheme, 100).join("\n");
          expect(rendered.split(explanation.message)).toHaveLength(2);
          yield* Deferred.succeed(finish, undefined);
          const completed = yield* Effect.promise(() => pending);
          // The program handled the failure, so the run warns rather than fails.
          const settled = summary(completed.details!);
          expect(settled?.outcome).toBe("warning");
          expect(settled?.issues).toEqual([]);
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
      expect(
        children.entries[1]!.issues!.some((issue) =>
          issue.message.includes("/tmp/retained-output.txt"),
        ),
      ).toBe(true);
      const compact = renderCompactChildren(children, plainTheme, 100).join("\n");
      const expanded = renderCompactChildren(children, plainTheme, 100, {
        layout: "flat",
        all: true,
      }).join("\n");
      const warning = children.entries[1]!.issues!.find((issue) => issue.severity === "warning")!;
      expect(compact.split(warning.message)).toHaveLength(2);
      expect(compact).not.toContain("/tmp/retained-output.txt");
      expect(compact).not.toContain("offset=3");
      expect(expanded.split("/tmp/retained-output.txt")).toHaveLength(2);
      expect(expanded).toContain("offset=3");
      // Each call owns its issues; the run does not repeat them.
      expect(projected?.issues).toEqual([]);
    }),
  );
});
