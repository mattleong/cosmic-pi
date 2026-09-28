import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_PRESENTATION_VERSION,
  type BackgroundTaskCodeModeCapability,
} from "pi-background-task/code-mode";
import * as previews from "pi-code-previews";
import {
  deferredPromise,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { makeCompactEvidence, type CompactReceipt } from "../src/tools/compact-evidence.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import {
  makeNestedPiToolDispatch,
  type NestedPiToolDefinitions,
} from "../src/boundary/host-builtin-tools.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { COMPLETE_LEDGER, deliveryIssues, summarize } from "./support/compact.ts";
import { executeHarness } from "./support/execute.ts";
import { renderResultText } from "./support/presentation.ts";
import { backgroundTaskProvider } from "./support/providers.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const result = <Details>(text = "", details?: Details) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const harness = (
  definitions: NestedPiToolDefinitions,
  options: { budget?: number; events?: ExtensionAPI["events"] } = {},
) =>
  executeHarness({
    definitions,
    cwd: "/project",
    retainFailureDetails: true,
    config: { maxToolCalls: 400, maxCumulativeChildOutputBytes: options.budget ?? 1000000 },
    ...(options.events && { events: options.events }),
  });
/** The model-visible failure text of a rejected execution. */
const failureText = (pending: Promise<unknown>) =>
  pending.then(
    () => expect.unreachable("execution should fail"),
    (error: Error) => error.message,
  );
type Ledger = ReturnType<typeof makeCompactEvidence>;
const settle = (ledger: Ledger, id: number, summary: previews.CompactSummary) => {
  ledger.start(id, id);
  ledger.observe(id, () => summary);
  ledger.end(id);
};

describe("compact receipt ledger", () => {
  it("counts receipt outcomes and publishes frozen, bounded receipts", () => {
    const published = new Map<number, CompactReceipt>();
    const ledger = makeCompactEvidence((id, receipt) => published.set(id, receipt));
    const outcomes = ["success", "warning", "error", "cancelled", "uncertain", "error"] as const;
    outcomes.forEach((outcome, id) => settle(ledger, id, { subject: `call ${id}`, outcome }));
    settle(ledger, 9, {
      subject: "curl -H 'Authorization: Bearer secret-token' host",
      compactSubject: "host",
      action: "fetch",
      counters: ["2 matches"],
      metadata: ["token=secret-token"],
      showTiming: true,
      outcome: "success",
      children: { total: 1, entries: [{ label: "nested", status: "success" }] },
    });
    ledger.close();
    expect(ledger.snapshot()).toEqual({
      ...COMPLETE_LEDGER,
      errors: 2,
      warnings: 1,
      cancelled: 1,
      uncertain: 1,
    });
    expect(Object.isFrozen(ledger.snapshot())).toBe(true);
    expect(published.get(0)).toEqual({
      version: 3,
      subject: "call 0",
      outcome: "success",
      issues: [],
      deliveryFailed: false,
    });
    const rich = published.get(9)!;
    expect(Object.isFrozen(rich)).toBe(true);
    expect(rich).toMatchObject({
      compactSubject: "host",
      action: "fetch",
      counters: ["2 matches"],
    });
    expect(rich).not.toHaveProperty("children");
    expect(rich).not.toHaveProperty("showTiming");
    expect(JSON.stringify(rich)).not.toContain("secret-token");
  });

  it("marks missing, duplicate, unstarted, overflowing and malformed observations incomplete", () => {
    const summary = { subject: "file", outcome: "success" } as const;
    const cases: ReadonlyArray<readonly [string, (ledger: Ledger) => void]> = [
      ["started but never observed", (ledger) => (ledger.start(1, 1), ledger.end(1))],
      ["still running at close", (ledger) => ledger.start(1, 1)],
      ["observed without a started call", (ledger) => ledger.observe(7, () => summary)],
      ["observed without correlation", (ledger) => ledger.observe(undefined, () => summary)],
      ["delivery failure without correlation", (ledger) => ledger.deliveryFailure(undefined)],
      ["producer reported missing presentation", (ledger) => ledger.missing()],
      [
        "duplicate observation",
        (ledger) => {
          ledger.start(1, 1);
          ledger.observe(1, () => summary);
          ledger.observe(1, () => summary);
          ledger.end(1);
        },
      ],
      ["declined projection", (ledger) => settle(ledger, 1, opaqueFixture(undefined))],
      [
        "throwing projection",
        (ledger) => {
          ledger.start(1, 1);
          ledger.observe(1, () => {
            throw new Error("projector failed");
          });
          ledger.end(1);
        },
      ],
      ["summary without an outcome", (ledger) => settle(ledger, 1, { subject: "file" })],
      [
        "issues beyond the receipt bound",
        (ledger) =>
          settle(ledger, 1, {
            ...summary,
            issues: Array.from({ length: 17 }, (_, id) => ({
              severity: "warning" as const,
              code: "partial",
              message: `Warning ${id}`,
            })),
          }),
      ],
    ];
    for (const [name, record] of cases) {
      const ledger = makeCompactEvidence(() => undefined);
      record(ledger);
      ledger.close();
      expect(ledger.snapshot().incomplete, name).toBe(true);
    }
    const complete = makeCompactEvidence(() => undefined);
    settle(complete, 1, summary);
    complete.close();
    expect(complete.snapshot().incomplete).toBe(false);
    // Long display fields are clipped so the call keeps its receipt and issues.
    const published: CompactReceipt[] = [];
    const long = makeCompactEvidence((_id, receipt) => published.push(receipt));
    settle(long, 1, { ...summary, subject: "x".repeat(2000), counters: ["y".repeat(2000)] });
    long.close();
    expect(long.snapshot().incomplete).toBe(false);
    expect(published[0]?.subject.length).toBeLessThanOrEqual(1024);
    expect(published[0]?.counters?.[0]?.length).toBeLessThanOrEqual(1024);
  });

  it("retains a summary without an outcome as uncertain rather than dropping the call", () => {
    let receipt: CompactReceipt | undefined;
    const ledger = makeCompactEvidence((_id, value) => {
      receipt = value;
    });
    settle(ledger, 1, { subject: "file" });
    expect(receipt).toMatchObject({ subject: "file", outcome: "uncertain" });
    expect(ledger.snapshot()).toMatchObject({ uncertain: 1, incomplete: true });
  });

  it("records one delivery failure without changing the operation outcome", () => {
    const published: CompactReceipt[] = [];
    const ledger = makeCompactEvidence((_id, receipt) => published.push(receipt));
    ledger.start(1, 4);
    ledger.observe(4, () => ({ subject: "file", outcome: "success" }));
    ledger.deliveryFailure(4);
    ledger.deliveryFailure(4);
    ledger.deliveryFailure(99);
    ledger.end(1);
    ledger.close();
    expect(published).toHaveLength(2);
    const receipt = published.at(-1)!;
    expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(deliveryIssues(receipt.issues)).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: "The result did not reach the program",
      }),
    ]);
    expect(deliveryIssues(receipt.issues)[0]?.detail).toContain("do not replay");
    expect(ledger.snapshot()).toEqual(COMPLETE_LEDGER);
  });

  it("keeps producer issues and marks the ledger incomplete when delivery loss meets the bound", () => {
    const published: CompactReceipt[] = [];
    const ledger = makeCompactEvidence((_id, receipt) => published.push(receipt));
    ledger.start(1, 1);
    ledger.observe(1, () => ({
      subject: "file",
      outcome: "warning",
      issues: Array.from({ length: 16 }, (_, index) => ({
        severity: "warning" as const,
        code: `w${index}`,
        message: `W${index}`,
      })),
    }));
    ledger.deliveryFailure(1);
    ledger.end(1);
    ledger.close();
    const issues = published.at(-1)!.issues;
    expect(issues).toHaveLength(16);
    expect(issues[0]?.message).toBe("W0");
    expect(deliveryIssues(issues)).toHaveLength(1);
    expect(ledger.snapshot().incomplete).toBe(true);
  });

  it("ignores late observations after close", () => {
    const published = vi.fn();
    const ledger = makeCompactEvidence(published);
    settle(ledger, 1, { subject: "file", outcome: "success" });
    ledger.start(2, 2);
    ledger.close();
    const before = ledger.snapshot();
    expect(ledger.identity(2)).toBeUndefined();
    ledger.observe(2, () => ({ subject: "late", outcome: "error" }));
    ledger.deliveryFailure(1);
    ledger.missing();
    expect(published).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot()).toEqual(before);
  });

  it("contains conflicting correlation and duplicate receipts", () => {
    const published = vi.fn();
    const collector = makeCompactEvidence(published);
    collector.start(1, 1);
    collector.start(1, 2);
    expect(collector.identity(1)).toBeUndefined();
    collector.observe(2, () => ({ subject: "wrong target", outcome: "success" }));
    expect(published).not.toHaveBeenCalled();
    collector.start(2, 3);
    collector.observe(3, () => ({ subject: "correct", outcome: "success" }));
    collector.observe(3, () => ({ subject: "duplicate", outcome: "error" }));
    expect(published).toHaveBeenCalledTimes(1);
    expect(collector.snapshot()).toMatchObject({ incomplete: true, errors: 0 });
  });
});

describe("compact semantic evidence through the real runtime", () => {
  it.effect(
    "keeps received native failures distinct from delivery loss and names the failed call",
    () =>
      Effect.gen(function* () {
        const diagnostic =
          "SOURCE_MARKER\nError: missing import\n  at stack-marker\nCommand exited with code 1";
        const editError =
          "Found 4 occurrences of edits[3] in file. Each oldText must be unique. Please provide more context to make it unique.";
        for (const [name, error, code, subject] of [
          ["bash", diagnostic, 'await tools.pi.bash({command:"run"})', "run"],
          [
            "edit",
            editError,
            'await tools.pi.edit({path:"file",edits:[{oldText:"a",newText:"b"}]})',
            "file",
          ],
        ] as const) {
          const h = harness(
            nestedToolDefinitionsFixture({
              [name]: { execute: () => Promise.reject(new Error(error)) },
            }),
          );
          const text = yield* Effect.promise(() => failureText(h.run(code)));
          const details = h.retention.consume("call")!;
          expect(details.compactAttention).toEqual({ ...COMPLETE_LEDGER, errors: 1 });
          const receipt = details.toolCalls[0]?.compact;
          expect(receipt).toMatchObject({ outcome: "error", deliveryFailed: false });
          expect(receipt?.issues.filter((issue) => issue.severity === "error")).toHaveLength(1);
          expect(deliveryIssues(receipt?.issues)).toEqual([]);
          expect(yield* encode(details)).not.toMatch(/SOURCE_MARKER|stack-marker/u);
          const compact = summarize(details, { isError: true, text });
          expect(compact?.outcome).toBe("error");
          // The failed call's own row explains the stop; the run adds no second line.
          expect(compact?.issues).toEqual([]);
          expect(previews.resolveCompactSummary(compact, "settled", true, text)?.issues).toEqual(
            [],
          );
          const row = compact?.children?.entries[0];
          expect(row).toMatchObject({ label: name, subject, status: "error" });
          expect(row?.issues?.find((issue) => issue.severity === "error")?.message).toMatch(
            /stopped the program/u,
          );
          // A failure the program handled leaves the call failed and the run a warning.
          const caught = yield* Effect.promise(() => h.run(`try { ${code}; } catch {} return 1;`));
          expect(caught.details?.toolCalls[0]?.compact?.deliveryFailed).toBe(false);
          const handled = summarize(caught.details!);
          expect(handled?.outcome).toBe("warning");
          expect(handled?.issues).toEqual([]);
          expect(handled?.children?.entries[0]?.status).toBe("error");
          const handledMessages = handled?.children?.entries.flatMap((child) =>
            (child.issues ?? []).map((issue) => issue.message),
          );
          expect(handledMessages?.join("\n")).not.toMatch(/stopped the program/u);
        }
      }),
  );

  it.effect(
    "records diagnostic clipping and native result-conversion loss as delivery failures",
    () =>
      Effect.gen(function* () {
        const failure = harness(
          nestedToolDefinitionsFixture({
            bash: {
              execute: () =>
                Promise.reject(
                  new Error(`${"diagnostic ".repeat(60)}\nCommand exited with code 1`),
                ),
            },
          }),
          { budget: 20 },
        );
        const clipped = yield* Effect.promise(() =>
          failure.run('try { await tools.pi.bash({command:"run"}); } catch {} return 1;'),
        );
        expect(clipped.details?.toolCalls[0]?.compact?.deliveryFailed).toBe(true);
        expect(deliveryIssues(clipped.details?.toolCalls[0]?.compact?.issues)).toHaveLength(1);
        const h = harness(
          nestedToolDefinitionsFixture({
            write: {
              execute: () =>
                Promise.resolve({
                  content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
                  details: {},
                }),
            },
          }),
        );
        const conversion = yield* Effect.promise(() =>
          h.run(
            'try { await tools.pi.write({path:"file",content:"private"}); } catch {} return 1;',
          ),
        );
        const receipt = conversion.details?.toolCalls[0]?.compact;
        expect(receipt?.deliveryFailed).toBe(true);
        expect(deliveryIssues(receipt?.issues)).toHaveLength(1);
        expect(summarize(conversion.details!)?.children?.entries[0]?.status).toBe("error");
      }),
  );

  it.effect(
    "correlates identical concurrent calls in reverse completion order through the real runtime",
    () =>
      Effect.gen(function* () {
        const started = deferredPromise();
        const pending = [1, 2].map(() => deferredPromise<ReturnType<typeof result>>());
        let calls = 0;
        const definitions = nestedToolDefinitionsFixture({
          grep: {
            execute: () => {
              if (++calls === 2) started.resolve();
              return pending[calls - 1]!.promise;
            },
          },
        });
        const execution = harness(definitions).run(
          'await Promise.all([1,2].map(() => tools.pi.grep({pattern:"same",path:"same"}))); return 1',
        );
        yield* Effect.promise(() => started.promise);
        pending[1]!.resolve(
          result("same: second", { matchLimitReached: 17, linesTruncated: true }),
        );
        pending[0]!.resolve(result("same: first", {}));
        const completed = yield* Effect.promise(() => execution);
        expect(completed.details?.compactAttention).toEqual({ ...COMPLETE_LEDGER, warnings: 1 });
        const [first, second] = completed.details!.toolCalls.map((call) => call.compact);
        expect(first?.issues).toEqual([]);
        expect(second?.outcome).toBe("warning");
        expect(second?.issues.length).toBeGreaterThan(0);
        expect(second?.counters).toContain("limit reached: 17");
        expect([first?.subject, second?.subject]).toEqual(["same in same", "same in same"]);
        expect(yield* encode(completed.details)).not.toContain("same: second");
      }),
  );

  it.effect("retains native completion separately from refused guest delivery", () =>
    Effect.gen(function* () {
      const definitions = nestedToolDefinitionsFixture({
        write: { execute: () => Promise.resolve(result("x".repeat(400))) },
      });
      const completed = yield* Effect.promise(() =>
        harness(definitions, { budget: 20 }).run(
          'try { await tools.pi.write({path:"file",content:"private body"}); } catch {} return 1',
        ),
      );
      const receipt = completed.details?.toolCalls[0]?.compact;
      expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
      expect(deliveryIssues(receipt?.issues)).toHaveLength(1);
      expect(receipt?.counters).not.toContain("new file");
      const projected = summarize(completed.details!);
      expect(projected?.children?.entries[0]?.status).toBe("error");
      expect(projected?.outcome).toBe("warning");
      expect(yield* encode(completed.details)).not.toContain("private body");
    }),
  );

  it.effect("records invalid arguments as a refusal, never as an observation", () =>
    Effect.gen(function* () {
      const native = vi.fn(() => Promise.resolve(result()));
      const h = harness(nestedToolDefinitionsFixture({ read: { execute: native } }));
      yield* Effect.promise(() =>
        failureText(h.run('await tools.pi.read({path:"file",offset:0})')),
      );
      expect(native).not.toHaveBeenCalled();
      const retained = h.retention.consume("call");
      expect(retained?.compactAttention).toEqual({ ...COMPLETE_LEDGER, errors: 1 });
      const receipt = retained?.toolCalls[0]?.compact;
      expect(receipt).toMatchObject({ outcome: "error", deliveryFailed: false });
      expect(receipt?.issues.map((issue) => issue.code)).toEqual(["not-sent:InvalidToolInput"]);
      // A caught refusal still explains its own row.
      const caught = yield* Effect.promise(() =>
        h.run('try { await tools.pi.read({path:"file",offset:0}); } catch {} return 1;'),
      );
      expect(caught.details?.toolCalls[0]?.compact?.issues[0]?.message).toMatch(/^Not sent: /u);
    }),
  );

  it.effect("guards throwing native observers without changing delivery", () =>
    Effect.gen(function* () {
      const dispatch = makeNestedPiToolDispatch({
        definitions: nestedToolDefinitionsFixture({
          read: { execute: () => Promise.resolve(result("native value")) },
        }),
        ctx: extensionContextFixture({ cwd: "/project" }),
        toolCallId: "guarded",
        observe: () => {
          throw new Error("observer failed");
        },
      });
      expect(yield* dispatch("read", { path: "file" })).toBe("native value");
    }),
  );

  it.effect("retains lost companion replies after observed completion", () =>
    Effect.gen(function* () {
      const events = backgroundTaskProvider(
        (_id, _input, _signal, _budget, observe) => {
          observe?.({
            version: BACKGROUND_TASK_PRESENTATION_VERSION,
            incomplete: false,
            overflow: false,
            summary: {
              action: "start",
              subject: "task",
              outcome: "success",
              metadata: [],
              counters: [],
              issues: [],
            },
          });
          return Promise.reject(new Error("Reply projection failed"));
        },
        { presentationVersion: BACKGROUND_TASK_PRESENTATION_VERSION },
      );
      const completed = yield* Effect.promise(() =>
        harness(nestedToolDefinitionsFixture({}), { events }).run(
          'try { await tools.session.backgroundTask({action:"start",command:"work"}); } catch {} return 1;',
        ),
      );
      const receipt = completed.details?.toolCalls[0]?.compact;
      expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
      expect(deliveryIssues(receipt?.issues)).toHaveLength(1);
      expect(summarize(completed.details!)?.children?.entries[0]).toMatchObject({
        label: "background_task",
        status: "error",
      });
    }),
  );

  it.effect("captures BG presentation before output projection and revokes late callbacks", () =>
    Effect.gen(function* () {
      let late: Parameters<BackgroundTaskCodeModeCapability["execute"]>[4];
      const events = backgroundTaskProvider(
        (_id, _input, _signal, _budget, observe) => {
          late = observe;
          observe?.({
            version: BACKGROUND_TASK_PRESENTATION_VERSION,
            incomplete: false,
            overflow: false,
            summary: {
              action: "logs",
              subject: "bg-1",
              outcome: "warning",
              metadata: [],
              counters: [],
              issues: [
                {
                  severity: "warning",
                  code: "log-dropped",
                  message: "Earlier log output is unavailable",
                },
              ],
            },
          });
          return Promise.resolve({
            action: "logs" as const,
            text: "private logs",
            logs: {
              id: "bg-1",
              nextCursor: 5,
              earliestAvailableCursor: 2,
              droppedBytes: 2,
              state: "running",
            },
          });
        },
        { presentationVersion: BACKGROUND_TASK_PRESENTATION_VERSION },
      );
      const completed = yield* Effect.promise(() =>
        harness(nestedToolDefinitionsFixture({}), { events }).run(
          'await tools.session.backgroundTask({action:"logs",id:"bg-1"}); return 1',
        ),
      );
      expect(completed.details?.toolCalls[0]?.compact).toMatchObject({
        action: "logs",
        outcome: "warning",
        issues: [expect.objectContaining({ message: "Earlier log output is unavailable" })],
      });
      const row = summarize(completed.details!)?.children?.entries[0];
      expect(row).toMatchObject({ label: "background_task", status: "warning" });
      const snapshot = yield* encode(completed.details);
      late?.({ version: BACKGROUND_TASK_PRESENTATION_VERSION, incomplete: true, overflow: true });
      expect(yield* encode(completed.details)).toBe(snapshot);
      expect(snapshot).not.toContain("private logs");
    }),
  );

  it.effect("preserves builtin limits and edit counts without retaining output or diffs", () =>
    Effect.gen(function* () {
      const definitions = nestedToolDefinitionsFixture({
        read: {
          execute: () =>
            Promise.resolve(
              result(
                "private output\n\n[Showing lines 1-2 of 20 (50.0KB limit). Use offset=3 to continue.]",
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
              result("private output", {
                truncation: { truncated: true },
                fullOutputPath: "/tmp/full-output",
              }),
            ),
        },
        grep: {
          execute: () =>
            Promise.resolve(
              result("private output", { matchLimitReached: 12, linesTruncated: true }),
            ),
        },
        find: {
          execute: () => Promise.resolve(result("private output", { resultLimitReached: 13 })),
        },
        ls: { execute: () => Promise.resolve(result("private output", { entryLimitReached: 14 })) },
        edit: {
          execute: () =>
            Promise.resolve(
              result("private output", {
                diff: "+private inserted text\n-private removed text",
                firstChangedLine: 1,
              }),
            ),
        },
      });
      const completed = yield* Effect.promise(() =>
        harness(definitions).run(
          'await tools.pi.read({path:"file"}); await tools.pi.bash({command:"pwd"}); await tools.pi.grep({pattern:"term"}); await tools.pi.find({pattern:"*"}); await tools.pi.ls({}); await tools.pi.edit({path:"file",edits:[{oldText:"a",newText:"b"},{oldText:"c",newText:"d"}]}); return 1',
        ),
      );
      const receipts = completed.details!.toolCalls.map((call) => call.compact);
      // A complete page is informational; its continuation stays in the expanded detail.
      expect(receipts[0]).toMatchObject({ outcome: "success" });
      expect(receipts[0]?.issues).toEqual([
        expect.objectContaining({ severity: "info", detail: expect.stringContaining("offset=3") }),
      ]);
      expect(receipts[1]?.outcome).toBe("warning");
      expect(receipts[1]?.issues.some((issue) => issue.message.includes("/tmp/full-output"))).toBe(
        true,
      );
      expect(receipts[2]?.counters).toContain("limit reached: 12");
      expect(receipts[3]?.counters).toContain("limit reached: 13");
      expect(receipts[4]?.counters).toContain("limit reached: 14");
      expect(receipts[5]?.counters?.join(" ")).toContain("2");
      expect(yield* encode(completed.details)).not.toMatch(
        /private output|private inserted text|private removed text/,
      );
    }),
  );

  it.effect("contains projector failure and preserves the native error and guest value", () =>
    Effect.gen(function* () {
      const spy = vi.spyOn(previews, "projectBuiltinCompactSummary").mockImplementation(() => {
        throw new Error("private projector failure");
      });
      try {
        const definitions = nestedToolDefinitionsFixture({
          read: { execute: () => Promise.resolve(result("native value")) },
          bash: { execute: () => Promise.reject(new Error("Command exited with code 3")) },
        });
        const completed = yield* Effect.promise(() =>
          harness(definitions).run(
            'let error=""; try { await tools.pi.bash({command:"false"}); } catch(e) { error=e.message; } return [await tools.pi.read({path:"file"}),error]',
          ),
        );
        expect(completed.content[0]).toMatchObject({
          text: expect.stringContaining("native value"),
        });
        expect(completed.details?.compactAttention?.incomplete).toBe(true);
        expect(summarize(completed.details!)?.issues).toContainEqual(
          expect.objectContaining({ severity: "warning", code: "incomplete" }),
        );
        expect(yield* encode(completed.details)).not.toContain("private projector failure");
      } finally {
        spy.mockRestore();
      }
    }),
  );

  it.effect("keeps read continuations expanded-only, through replay and after outer failure", () =>
    Effect.gen(function* () {
      const hint = "[Showing lines 1-2 of 20 (50.0KB limit). Use offset=3 to continue.]";
      const h = harness(
        nestedToolDefinitionsFixture({
          bash: {
            execute: () =>
              Promise.resolve(
                result("output", {
                  truncation: { truncated: true },
                  fullOutputPath: "/tmp/recovery-output",
                }),
              ),
          },
          read: {
            execute: () =>
              Promise.resolve(
                result(`private output\n\n${hint}`, {
                  truncation: {
                    truncated: true,
                    truncatedBy: "bytes",
                    lastLinePartial: false,
                    firstLineExceedsLimit: false,
                  },
                }),
              ),
          },
        }),
      );
      const completed = yield* Effect.promise(() =>
        h.run('await tools.pi.read({path:"file"}); return 1'),
      );
      expect(completed.content[0]).toMatchObject({ text: "1" });
      expect(summarize(completed.details!)?.outcome).toBe("success");
      expect(completed.details?.compactAttention).toEqual(COMPLETE_LEDGER);
      const serialized = yield* encode(completed.details);
      const replay = decodeCodeModeRenderDetails(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(serialized),
      );
      expect(replay.toolCalls[0]?.compact?.issues[0]).toMatchObject({ severity: "info" });
      for (const expanded of [false, true]) {
        const text = renderResultText(completed, { expanded });
        expect(text.includes("offset=3")).toBe(expanded);
      }
      // A failing host theme falls back to plain output rather than throwing.
      const brokenTheme = opaqueFixture({
        fg: () => {
          throw new Error("theme");
        },
        bold: (text: string) => text,
      });
      for (const expanded of [false, true])
        expect(() => renderResultText(completed, { expanded, theme: brokenTheme })).not.toThrow();
      expect(renderResultText(completed, { expanded: true, theme: plainTheme })).toContain("1");

      const text = yield* Effect.promise(() =>
        failureText(
          h.run(
            'await tools.pi.read({path:"file"}); await tools.pi.read({path:"file"}); await tools.pi.bash({command:"example"}); throw new Error("outer failure")',
          ),
        ),
      );
      const summary = summarize(h.retention.consume("call")!, { isError: true, text });
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues).toEqual([
        expect.objectContaining({ severity: "error", message: "outer failure (line 1)" }),
      ]);
      const childIssues = summary?.children?.entries.flatMap((child) => child.issues ?? []) ?? [];
      expect(
        childIssues.filter(
          (issue) => issue.severity === "info" && issue.detail?.includes("offset=3"),
        ),
      ).toHaveLength(2);
      expect(childIssues.some((issue) => issue.message.includes("/tmp/recovery-output"))).toBe(
        true,
      );
    }),
  );
});
