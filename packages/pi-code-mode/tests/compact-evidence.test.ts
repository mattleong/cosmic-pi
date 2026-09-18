import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
} from "pi-background-task/code-mode";
import * as previews from "pi-code-previews";
import { renderCodeModeToolResult } from "../src/ui/tool-renderer.ts";
import { makeCompactEvidence } from "../src/tools/compact-evidence.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { makeFailureDetailsRetention } from "../src/tools/retention.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { makeNestedPiToolDispatch } from "../src/boundary/host-builtin-tools.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import type { CodeModeCallEntry, CodeModeToolDetails } from "../src/tools/format.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = Effect.runPromise(
    Effect.callback<A>((resume) => {
      resolve = (value) => resume(Effect.succeed(value));
    }),
  );
  return { promise, resolve };
};
const result = <Details>(text = "", details?: Details) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const project = (details: CodeModeToolDetails) =>
  codeModeCompactSummary({
    phase: "settled",
    args: {},
    result: result("discarded", details),
    context: opaqueHostFixture({ isError: false }),
  });
const harness = (
  definitions: NestedPiToolDefinitions,
  options: { budget?: number; events?: ReturnType<typeof createEventBus> } = {},
) => {
  const state = codeModeStateFixture({
    maxToolCalls: 400,
    maxCumulativeChildOutputBytes: options.budget ?? 1000000,
  });
  const retention = makeFailureDetailsRetention();
  const run = makeCodeModeToolExecute({
    isCurrent: () => true,
    getState: () => state,
    runInSession: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
    definitions,
    events: options.events ?? createEventBus(),
    sessionId: "compact",
    retainFailureDetails: retention.retain,
  });
  return {
    retention,
    run: (code: string, signal?: AbortSignal) =>
      run("compact", { code }, signal, undefined, extensionContextFixture({ cwd: "/project" })),
  };
};

describe("compact semantic evidence", () => {
  it.effect(
    "keeps received native failures distinct from delivery loss and puts known diagnostics only in expanded details",
    () =>
      Effect.gen(function* () {
        const diagnostic =
          "SOURCE_MARKER\nError: missing import\n  at stack-marker\nCommand exited with code 1";
        const editError =
          "Found 4 occurrences of edits[3] in file. Each oldText must be unique. Please provide more context to make it unique.";
        for (const [name, error, code] of [
          ["bash", diagnostic, 'await tools.pi.bash({command:"run"})'],
          [
            "edit",
            editError,
            'await tools.pi.edit({path:"file",edits:[{oldText:"a",newText:"b"}]})',
          ],
        ] as const) {
          const h = harness(
            nestedToolDefinitionsFixture({
              [name]: { execute: () => Promise.reject(new Error(error)) },
            }),
          );
          yield* Effect.promise(() => expect(h.run(code)).rejects.toThrow(error));
          const details = h.retention.consume("compact")!;
          expect(details.compactAttention).toMatchObject({
            observed: 1,
            errors: 1,
            incomplete: false,
          });
          expect(details.toolCalls[0]?.compact).toMatchObject({
            outcome: "error",
            deliveryFailed: false,
          });
          expect(details.failurePresentation?.evidence.coverage).toBe("complete");
          const serialized = yield* encode(details);
          expect(serialized).not.toMatch(/SOURCE_MARKER|stack-marker|may already have completed/u);
          const text = `[ToolFailure] Nested tool '${name}' failed: ${error}`;
          const compact = codeModeCompactSummary({
            phase: "settled",
            args: {},
            result: result(text, details),
            context: opaqueHostFixture({ isError: true, expanded: false }),
          });
          expect(compact?.failure?.details).toBe(text);
          expect(compact?.failure?.cause).toBe(details.failurePresentation?.evidence.cause);
          expect(
            compact?.children?.entries[0]?.notices?.filter((notice) => notice.kind === "error"),
          ).toHaveLength(1);
          expect(
            compact?.notices?.some((notice) =>
              /SOURCE_MARKER|stack-marker|nested operations failed|delivery|incomplete/u.test(
                notice.text,
              ),
            ),
          ).toBe(false);
          const caught = yield* Effect.promise(() => h.run(`try { ${code}; } catch {} return 1;`));
          expect(caught.details?.toolCalls[0]?.compact?.deliveryFailed).toBe(false);
          expect(project(caught.details!)?.outcome).toBe("error");
        }
      }),
  );

  it.effect("preserves actual diagnostic clipping and native result-conversion loss", () =>
    Effect.gen(function* () {
      const failure = harness(
        nestedToolDefinitionsFixture({
          bash: {
            execute: () =>
              Promise.reject(new Error(`${"diagnostic ".repeat(60)}\nCommand exited with code 1`)),
          },
        }),
        { budget: 20 },
      );
      const clipped = yield* Effect.promise(() =>
        failure.run('try { await tools.pi.bash({command:"run"}); } catch {} return 1;'),
      );
      expect(clipped.details?.toolCalls[0]?.compact?.deliveryFailed).toBe(true);
      expect(
        clipped.details?.compactAttention?.notices.some((notice) =>
          notice.text.includes("do not replay"),
        ),
      ).toBe(true);
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
        h.run('try { await tools.pi.write({path:"file",content:"private"}); } catch {} return 1;'),
      );
      expect(conversion.details?.toolCalls[0]?.compact?.deliveryFailed).toBe(true);
      expect(
        conversion.details?.compactAttention?.notices.some((notice) =>
          notice.text.includes("do not replay"),
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "correlates identical concurrent calls in reverse completion order through the real runtime",
    () =>
      Effect.gen(function* () {
        const started = deferred<void>();
        const pending: Array<ReturnType<typeof deferred<ReturnType<typeof result>>>> = [];
        const definitions = nestedToolDefinitionsFixture({
          grep: {
            execute: () => {
              const request = deferred<ReturnType<typeof result>>();
              pending.push(request);
              if (pending.length === 2) started.resolve();
              return request.promise;
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
        expect(completed.details?.compactAttention).toMatchObject({
          admitted: 2,
          started: 2,
          observed: 2,
          incomplete: false,
        });
        expect(completed.details?.toolCalls[0]?.compact?.notices).toEqual([]);
        expect(completed.details?.toolCalls[1]?.compact?.notices.length).toBeGreaterThan(0);
        expect(completed.details?.toolCalls.map((call) => call.compact?.subject)).toEqual([
          "same in same",
          "same in same",
        ]);
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
      expect(receipt).toMatchObject({ outcome: "warning", deliveryFailed: true });
      expect(receipt?.notices.some((notice) => /previous content|before/i.test(notice.text))).toBe(
        true,
      );
      expect(receipt?.counters).not.toContain("new file");
      expect(project(completed.details!)?.children?.entries[0]?.status).toBe("error");
      expect(
        completed.details?.compactAttention?.notices.some((notice) =>
          notice.text.includes("do not replay"),
        ),
      ).toBe(true);
      expect(yield* encode(completed.details)).not.toContain("private body");
    }),
  );

  it.effect("does not invent observations for invalid arguments", () =>
    Effect.gen(function* () {
      const native = vi.fn(() => Promise.resolve(result()));
      const h = harness(nestedToolDefinitionsFixture({ read: { execute: native } }));
      yield* Effect.promise(() =>
        expect(h.run('await tools.pi.read({path:"file",offset:0})')).rejects.toThrow(),
      );
      expect(native).not.toHaveBeenCalled();
      expect(h.retention.consume("compact")?.compactAttention).toMatchObject({
        observed: 0,
        started: 0,
      });
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

  it("keeps warning evidence beyond row eviction and reports bounded overflow", () => {
    const collector = makeCompactEvidence(() => undefined);
    for (let id = 0; id < 300; id++) {
      collector.admit("pi.read");
      collector.start(id, id);
      collector.observe(collector.identity(id), () => ({
        subject: "file",
        outcome: "warning",
        notices: [{ kind: "recovery", text: `Recover ${id}` }],
      }));
      collector.end(id);
    }
    collector.close();
    expect(collector.snapshot()).toMatchObject({
      admitted: 300,
      started: 300,
      observed: 300,
      incomplete: true,
    });
    expect(collector.snapshot().notices).toHaveLength(32);
    expect(collector.snapshot().notices[0]?.text).toBe("Recover 0");
  });

  it("retains valid sibling notices when another field exceeds bounds and excludes failure bodies", () => {
    const collector = makeCompactEvidence(() => undefined);
    collector.admit("pi.read");
    collector.start(1, 1);
    collector.observe(1, () => ({
      subject: "x".repeat(3000),
      outcome: "error",
      failure: { cause: "secret output", details: "secret output" },
      notices: [{ kind: "recovery", text: "Keep this instruction" }],
    }));
    expect(collector.snapshot()).toMatchObject({
      incomplete: true,
      notices: [{ text: "Keep this instruction" }],
    });
    expect(JSON.stringify(collector.snapshot())).not.toContain("secret output");
    const before = collector.snapshot();
    collector.close();
    collector.observe(1, () => ({ subject: "late" }));
    expect(before.notices).toEqual(collector.snapshot().notices);
    expect(Object.isFrozen(before.notices)).toBe(true);
  });

  it("rejects incomplete replay coverage instead of using legacy success", () => {
    const collector = makeCompactEvidence(() => undefined);
    const details = {
      toolCalls: [{ tool: "pi.read", status: "completed" as const }],
      counts: { total: 1, succeeded: 1, running: 0, queued: 0, failed: 0, cancelled: 0 },
      outputKind: "text" as const,
      compactAttention: collector.snapshot(),
    };
    expect(decodeCodeModeRenderDetails(details).compactAttention?.incomplete).toBe(true);
    expect(project(details)?.outcome).toBe("uncertain");
  });

  it.effect("retains lost companion replies after observed completion", () =>
    Effect.gen(function* () {
      const events = createEventBus();
      events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) =>
        normalizeBackgroundTaskCodeModeQuery(value)?.respond({
          version: 1,
          presentationVersion: 1,
          sessionId: "compact",
          execute: (_id, _input, _signal, _budget, observe) => {
            observe?.({
              version: 1,
              incomplete: false,
              overflow: false,
              summary: {
                action: "start",
                subject: "task",
                outcome: "success",
                metadata: [],
                counters: [],
                notices: [],
                detailsOnExpand: true,
              },
            });
            return Promise.reject(new Error("Reply projection failed"));
          },
        } satisfies BackgroundTaskCodeModeCapability),
      );
      const completed = yield* Effect.promise(() =>
        harness(nestedToolDefinitionsFixture({}), { events }).run(
          'try { await tools.session.backgroundTask({action:"start",command:"work"}); } catch {} return 1;',
        ),
      );
      expect(completed.details?.toolCalls[0]?.compact).toMatchObject({
        outcome: "success",
        deliveryFailed: true,
      });
      expect(
        completed.details?.compactAttention?.notices.some((notice) =>
          notice.text.includes("do not replay"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("captures BG presentation before output projection and revokes late callbacks", () =>
    Effect.gen(function* () {
      const events = createEventBus();
      let late: Parameters<BackgroundTaskCodeModeCapability["execute"]>[4];
      events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) =>
        normalizeBackgroundTaskCodeModeQuery(value)?.respond({
          version: 1,
          presentationVersion: 1,
          sessionId: "compact",
          execute: (_id, _input, _signal, _budget, observe) => {
            late = observe;
            observe?.({
              version: 1,
              incomplete: false,
              overflow: false,
              summary: {
                action: "logs",
                subject: "bg-1",
                outcome: "warning",
                metadata: [],
                counters: [],
                notices: [{ kind: "recovery", text: "Earlier log output is unavailable" }],
                detailsOnExpand: true,
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
        } satisfies BackgroundTaskCodeModeCapability),
      );
      const completed = yield* Effect.promise(() =>
        harness(nestedToolDefinitionsFixture({}), { events }).run(
          'await tools.session.backgroundTask({action:"logs",id:"bg-1"}); return 1',
        ),
      );
      expect(completed.details?.toolCalls[0]?.compact).toMatchObject({
        action: "logs",
        outcome: "warning",
      });
      expect(project(completed.details!)?.children?.entries[0]?.label).toBe("background_task");
      const snapshot = yield* encode(completed.details);
      late?.({ version: 1, incomplete: true, overflow: true });
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
      expect(receipts[0]?.notices.length).toBeGreaterThan(0);
      expect(receipts[1]?.notices.some((notice) => notice.text.includes("/tmp/full-output"))).toBe(
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
        expect(yield* encode(completed.details)).not.toContain("private projector failure");
      } finally {
        spy.mockRestore();
      }
    }),
  );

  it("keeps overflow and hidden warnings visible in compact and detailed views", () => {
    const collector = makeCompactEvidence(() => undefined);
    for (let id = 0; id < 270; id++) {
      collector.admit("pi.read");
      collector.start(id, id);
      collector.observe(id, () => ({
        subject: "file",
        outcome: "warning",
        notices: [{ kind: "recovery", text: `Recovery ${id}` }],
      }));
      collector.end(id);
    }
    collector.close();
    const details: CodeModeToolDetails = {
      toolCalls: [],
      counts: { total: 270, succeeded: 270, failed: 0, cancelled: 0, running: 0, queued: 0 },
      totalToolCalls: 270,
      outputKind: "text",
      compactAttention: collector.snapshot(),
    };
    expect(project(details)?.issues?.entries.some((issue) => issue.cause === "Recovery 0")).toBe(
      true,
    );
    expect(project(details)?.notices?.some((notice) => notice.text.includes("warning limit"))).toBe(
      true,
    );
    const theme = opaqueHostFixture({
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    for (const expanded of [false, true]) {
      const rendered = renderCodeModeToolResult(
        result("discarded", details),
        { isPartial: false },
        theme,
        { isError: false, expanded },
      )
        .component.render(180)
        .join("\n");
      expect(rendered).toContain("Recovery 0");
      expect(rendered).toContain("warning limit");
    }
  });

  it("preserves retained receipt recovery on expansion after aggregate overflow", () => {
    const calls: CodeModeCallEntry[] = [];
    const collector = makeCompactEvidence((_id, compact) => {
      calls.push({ tool: "pi.read", status: "completed", compact });
    });
    for (let id = 0; id < 33; id++) {
      collector.admit("pi.read");
      collector.start(id, id);
      collector.observe(id, () => ({
        subject: "file",
        outcome: "warning",
        notices: [{ kind: "recovery", text: `Recovery instruction ${id}.` }],
      }));
      collector.end(id);
    }
    collector.close();
    const details: CodeModeToolDetails = {
      toolCalls: calls.slice(-32),
      outputKind: "text",
      counts: { total: 33, succeeded: 33, failed: 0, cancelled: 0, running: 0, queued: 0 },
      compactAttention: collector.snapshot(),
    };
    const summary = project(details)!;
    expect(summary.notices?.filter((notice) => !notice.expandedInResult)).toEqual([]);
    const theme = opaqueHostFixture({
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    const rendered = renderCodeModeToolResult(
      result("discarded", details),
      { isPartial: false },
      theme,
      { isError: false, expanded: true },
    )
      .component.render(240)
      .join("\n");
    for (let id = 0; id < 33; id++) {
      expect(rendered.split(`Recovery instruction ${id}.`)).toHaveLength(2);
    }
    expect(rendered).toContain("warning limit");
  });

  it("rejects aggregate outcome counts contradicted by retained receipts", () => {
    for (const outcome of ["error", "warning", "cancelled", "uncertain"] as const) {
      const calls: CodeModeCallEntry[] = [];
      const collector = makeCompactEvidence((_id, compact) => {
        calls.push({ tool: "session.backgroundTask", status: "completed", compact });
      });
      collector.admit("session.backgroundTask");
      collector.start(1, 1);
      collector.observe(1, () => ({ subject: "task", outcome }));
      collector.end(1);
      collector.close();
      const details: CodeModeToolDetails = {
        toolCalls: calls,
        outputKind: "text",
        counts: { total: 1, succeeded: 1, failed: 0, cancelled: 0, running: 0, queued: 0 },
        compactAttention: {
          ...collector.snapshot(),
          errors: 0,
          warnings: 0,
          cancelled: 0,
          uncertain: 0,
        },
      };
      expect(decodeCodeModeRenderDetails(details).compactAttention?.incomplete).toBe(true);
      expect(project(details)?.outcome).toBe("uncertain");
    }
  });

  it.effect(
    "retains discarded complete-line read hints only on expansion and after outer failure",
    () =>
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
        expect(project(completed.details!)?.outcome).toBe("success");
        expect(completed.details?.compactAttention).toMatchObject({
          warnings: 0,
          incomplete: false,
          notices: [],
        });
        const serialized = yield* encode(completed.details);
        const replay = decodeCodeModeRenderDetails(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(serialized),
        );
        expect(replay.toolCalls[0]?.compact?.notices[0]).toMatchObject({ expandedOnly: true });
        expect(project(completed.details!)?.children?.entries[0]?.notices).toContainEqual(
          expect.objectContaining({ expandedOnly: true }),
        );
        const theme = opaqueHostFixture({
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        });
        const brokenTheme = opaqueHostFixture({
          fg: () => {
            throw new Error("theme");
          },
          bold: (text: string) => text,
        });
        for (const currentTheme of [theme, brokenTheme]) {
          for (const expanded of [false, true]) {
            const text = renderCodeModeToolResult(completed, { isPartial: false }, currentTheme, {
              expanded,
            })
              .component.render(240)
              .join("\n");
            expect(text.includes("offset=3")).toBe(expanded);
          }
        }
        yield* Effect.promise(() =>
          expect(
            h.run(
              'await tools.pi.read({path:"file"}); await tools.pi.read({path:"file"}); await tools.pi.bash({command:"example"}); throw new Error("outer failure")',
            ),
          ).rejects.toThrow(),
        );
        const retained = h.retention.consume("compact")!;
        const summary = codeModeCompactSummary({
          phase: "settled",
          args: {},
          result: result("outer failure", retained),
          context: opaqueHostFixture({ isError: true, expanded: true }),
        });
        expect(summary?.outcome).toBe("error");
        expect(summary?.notices).toContainEqual(
          expect.objectContaining({ expandedOnly: true, expandedInResult: true }),
        );
        expect(summary?.notices?.filter((notice) => notice.expandedOnly)).toHaveLength(2);
        expect(
          summary?.issues?.entries.some((issue) =>
            issue.recovery.some((instruction) => instruction.text.includes("/tmp/recovery-output")),
          ),
        ).toBe(true);
      }),
  );

  it("does not spend attention capacity on routine hints or hide flagged warnings", () => {
    const collector = makeCompactEvidence(() => undefined);
    for (let id = 0; id < 72; id++) {
      collector.admit("pi.read");
      collector.start(id, id);
      collector.observe(id, () => ({
        subject: "file",
        outcome: id < 40 ? "success" : "warning",
        notices: [
          { kind: id < 40 ? "recovery" : "warning", text: `Notice ${id}`, expandedOnly: true },
        ],
      }));
      collector.end(id);
    }
    collector.close();
    expect(collector.snapshot()).toMatchObject({ observed: 72, warnings: 32, incomplete: false });
    expect(collector.snapshot().notices).toHaveLength(32);
    expect(collector.snapshot().notices[0]?.text).toBe("Notice 40");
    const details: CodeModeToolDetails = {
      toolCalls: [],
      outputKind: "text",
      counts: { total: 72, succeeded: 72, failed: 0, cancelled: 0, running: 0, queued: 0 },
      compactAttention: collector.snapshot(),
    };
    expect(project(details)?.outcome).toBe("warning");
    const theme = opaqueHostFixture({
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    for (const expanded of [false, true]) {
      const text = renderCodeModeToolResult(result("1", details), { isPartial: false }, theme, {
        expanded,
      })
        .component.render(240)
        .join("\n");
      expect(text).toContain("Notice 40");
      expect(text).not.toContain("Notice 0");
    }
  });

  it("contains conflicting correlation and duplicate receipts", () => {
    const published = vi.fn();
    const collector = makeCompactEvidence(published);
    collector.admit("pi.read");
    collector.start(1, 1);
    collector.start(1, 2);
    expect(collector.identity(1)).toBeUndefined();
    collector.observe(2, () => ({ subject: "wrong target", outcome: "success" }));
    expect(published).not.toHaveBeenCalled();
    collector.start(2, 3);
    collector.observe(3, () => ({ subject: "correct", outcome: "success" }));
    collector.observe(3, () => ({ subject: "duplicate", outcome: "error" }));
    expect(published).toHaveBeenCalledTimes(1);
    expect(collector.snapshot()).toMatchObject({ incomplete: true, observed: 1, errors: 0 });
  });
});
