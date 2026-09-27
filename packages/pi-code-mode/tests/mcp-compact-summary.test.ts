import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as mcpPresentation from "pi-mcp/code-mode";
import {
  projectMcpCompactSummary,
  mcpCodeModeError,
  type McpCodeModeCapability,
  type McpCodeModeOutput,
} from "pi-mcp/code-mode";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import { deferredPromise, opaqueFixture } from "pi-cosmic-core/testing";
import { COMPLETE_LEDGER } from "./support/compact.ts";
import { executeHarness, type CallOptions } from "./support/execute.ts";
import { mcpProvider } from "./support/providers.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const summary = <Details>(
  details: Details,
  isError = false,
  phase: "running" | "settled" = "settled",
) =>
  codeModeCompactSummary({
    phase,
    args: { intent: "Inspect MCP" },
    result: { details, content: [{ type: "text", text: "Guest discarded the MCP payload" }] },
    context: opaqueFixture({ isError }),
  });
const reply = (patch: Partial<McpCodeModeOutput> = {}): McpCodeModeOutput => ({
  action: "status",
  outcome: "completed",
  isError: false,
  data: null,
  notices: [],
  ...patch,
});
const harness = (provider: McpCodeModeCapability["execute"], maxOutputBytes = 100000) => {
  const { retention, run } = executeHarness({
    events: mcpProvider(provider),
    retainFailureDetails: true,
    config: { maxToolCalls: 400, maxOutputBytes, maxCumulativeChildOutputBytes: 1000000 },
  });
  return {
    retention,
    run: (
      code = 'await tools.mcp.request({action:"status"}); return "discarded"',
      onUpdate?: CallOptions["onUpdate"],
      signal?: AbortSignal,
    ) => run(code, { onUpdate, signal }),
  };
};
/** Nested calls never make their run an error: only a clean call leaves it successful. */
const parentOutcome = (child: string) => (child === "success" ? "success" : "warning");

describe("MCP execution evidence in compact Code Mode results", () => {
  it.effect("keeps action-specific repair evidence in the nested call's expanded detail", () =>
    Effect.gen(function* () {
      const output = reply({
        action: "prompts.get",
        outcome: "not-sent",
        isError: true,
        data: {
          kind: "invalid-input",
          reason: "gateway-request-invalid",
          message:
            "prompts.get requires string-valued arguments. Use prompts.list to inspect declared arguments.",
        },
      });
      const completed = yield* Effect.promise(() =>
        harness(() => Promise.resolve(output)).run(
          'await tools.mcp.request({action:"prompts.get",server:"catalog",prompt:"inspect"}); return "discarded"',
        ),
      );
      const retained = completed.details?.toolCalls[0]?.compact;
      expect(retained?.outcome).toBe("error");
      expect(retained?.issues.some((issue) => issue.detail?.includes("prompts.list"))).toBe(true);
      expect(retained?.issues.some((issue) => issue.message.includes("prompts.list"))).toBe(false);
      const projected = summary(completed.details);
      expect(projected?.outcome).toBe("warning");
      expect(projected?.issues).toEqual([]);
      expect(projected?.children?.entries[0]).toMatchObject({ label: "mcp", status: "error" });
    }),
  );

  it.effect("uses the same issues standalone and nested", () =>
    Effect.gen(function* () {
      const args = { action: "tools.describe" as const, server: "catalog", tool: "inspect" };
      const output = reply({
        action: args.action,
        resultId: "retained-1",
        notices: [
          "MCP catalog resources catalog is unavailable because its listing method was not found.",
          "MCP catalog templates catalog is unavailable because its listing method was not found.",
          "MCP catalog cached metadata is not fresh; invocation requires current metadata.",
        ],
      });
      const standalone = projectMcpCompactSummary({
        phase: "settled",
        args,
        result: { details: output },
        isError: false,
      });
      const completed = yield* Effect.promise(() =>
        harness(() => Promise.resolve(output)).run(
          'await tools.mcp.request({action:"tools.describe",server:"catalog",tool:"inspect"}); return 1',
        ),
      );
      expect(completed.details?.toolCalls[0]?.compact?.issues).toEqual(standalone?.issues);
      expect(completed.details?.compactAttention).toEqual(COMPLETE_LEDGER);
      expect(summary(completed.details)?.outcome).toBe(parentOutcome(standalone!.outcome!));
      const discovery = reply({
        action: "tools.search",
        resultId: "retained-search",
        data: { result: { undiscovered: ["other"] } },
      });
      const direct = projectMcpCompactSummary({
        phase: "settled",
        args: { action: "tools.search", query: "x" },
        result: { details: discovery },
        isError: false,
      });
      expect(mcpPresentation.projectMcpPresentation(discovery).issues).toEqual(direct?.issues);
    }),
  );

  it.effect.each([
    [reply(), "success"],
    [reply({ isError: true }), "error"],
    [reply({ outcome: "unknown" }), "uncertain"],
    [reply({ outcome: "not-sent" }), "warning"],
    [reply({ notices: ["Inspect server access before continuing."] }), "warning"],
    [reply({ action: "tools.list", data: { result: { undiscovered: ["server"] } } }), "warning"],
    [reply({ data: { truncated: true } }), "warning"],
    [reply({ data: { result: { undiscovered: ["server"] } } }), "success"],
    [reply({ data: { result: { truncated: true } } }), "success"],
  ] as const)("uses validated envelopes independently of guest output: %j", ([output, status]) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.resolve(output)).run(
          output.action === "tools.list"
            ? 'await tools.mcp.request({action:"tools.list"}); return "discarded"'
            : undefined,
        ),
      );
      const projected = summary(result.details);
      expect(projected?.outcome).toBe(parentOutcome(status));
      expect(projected?.issues).toEqual([]);
      expect(projected?.children?.entries).toMatchObject([{ label: "mcp", status }]);
    }),
  );

  it.effect.each([
    [{ outcome: "completed", isError: false }, "success"],
    [{ outcome: "completed", isError: true }, "error"],
    [{ outcome: "unknown", isError: false }, "uncertain"],
    [{ outcome: "not-sent", isError: false }, "warning"],
    [{ outcome: "completed", isError: false, outputValidation: "failed" }, "error"],
    [{ outcome: "completed", isError: false, outputValidation: "unavailable" }, "warning"],
    [{ outcome: "completed" }, "uncertain"],
    [undefined, "uncertain"],
    [{ outcome: "not-sent", isError: false }, "uncertain", "unknown"],
  ] as const)(
    "does not promote a retained read over its origin or envelope: %j",
    ([origin, status, envelope]) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          harness(() =>
            Promise.resolve(
              reply({
                action: "result.read",
                ...(envelope && { outcome: envelope }),
                data: origin === undefined ? {} : { origin },
              }),
            ),
          ).run('await tools.mcp.request({action:"result.read",id:"retained"}); return 1'),
        );
        expect(summary(result.details)?.outcome).toBe(parentOutcome(status));
        expect(summary(result.details)?.children?.entries).toMatchObject([
          { label: "mcp", status },
        ]);
      }),
  );

  it.effect.each([
    [mcpCodeModeError("output-limit", "completed"), "error"],
    [mcpCodeModeError("unavailable", "not-sent"), "error"],
    [new Error("SECRET_CREDENTIAL"), "uncertain"],
  ] as const)("retains caught rejection certainty without raw errors", ([error, status]) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.reject(error)).run(
          'try { await tools.mcp.request({action:"status"}); } catch {} return 1',
        ),
      );
      expect(summary(result.details)?.outcome).toBe("warning");
      expect(yield* encode(result.details)).not.toContain("SECRET_CREDENTIAL");
      expect(result.details?.counts?.failed).toBe(1);
      expect(summary(result.details)?.children?.entries).toMatchObject([{ label: "mcp", status }]);
    }),
  );

  it.effect("joins parallel mixed outcomes without last-call-wins state", () =>
    Effect.gen(function* () {
      const started = deferredPromise();
      const replies = [1, 2, 3].map(() => deferredPromise<McpCodeModeOutput>());
      let calls = 0;
      const pending = harness(() => {
        if (++calls === 3) started.resolve();
        return replies[calls - 1]!.promise;
      }).run(
        'await Promise.all([1,2,3].map(() => tools.mcp.request({action:"status"}))); return 1',
      );
      yield* Effect.promise(() => started.promise);
      replies[2]!.resolve(reply());
      replies[1]!.resolve(reply({ outcome: "unknown" }));
      replies[0]!.resolve(reply());
      const result = yield* Effect.promise(() => pending);
      expect(result.details?.compactAttention).toEqual({ ...COMPLETE_LEDGER, uncertain: 1 });
      expect(summary(result.details)?.outcome).toBe("warning");
      expect(summary(result.details)?.children?.entries).toMatchObject([
        { label: "mcp", status: "success" },
        { label: "mcp", status: "uncertain" },
        { label: "mcp", status: "success" },
      ]);
    }),
  );

  it.effect.each([40, 270])("covers %i calls beyond visible and tracked history", (count) =>
    Effect.gen(function* () {
      let index = 0;
      const result = yield* Effect.promise(() =>
        harness(() =>
          Promise.resolve(
            ++index === 1 ? reply({ notices: ["Early recovery evidence"] }) : reply(),
          ),
        ).run(`for (let i=0;i<${count};i++) await tools.mcp.request({action:"status"}); return 1`),
      );
      expect(result.details?.toolCalls).toHaveLength(32);
      const projected = summary(result.details);
      expect(projected?.children?.total).toBe(count);
      expect(projected?.children?.entries).toHaveLength(32);
      // The first call's warning outlives its evicted row through the ledger.
      expect(result.details?.compactAttention).toEqual({ ...COMPLETE_LEDGER, warnings: 1 });
      expect(projected?.children?.entries.every((child) => child.status === "success")).toBe(true);
      expect(projected?.outcome).toBe("warning");
    }),
  );

  it.effect("does not lose hidden unsupported calls", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.resolve(reply())).run(
          'try { await tools.session.backgroundTask({action:"list"}); } catch {} for (let i=0;i<270;i++) await tools.mcp.request({action:"status"}); return 1',
        ),
      );
      expect(result.details?.counts?.failed).toBe(1);
      expect(summary(result.details)?.outcome).toBe("warning");
    }),
  );

  it.effect("declines a stripped ledger without using a legacy success path", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => harness(() => Promise.resolve(reply())).run());
      expect(summary({ ...result.details, compactAttention: undefined })).toBeUndefined();
    }),
  );

  it.effect("marks the call incomplete when outcome classification fails", () =>
    Effect.gen(function* () {
      const original = mcpPresentation.projectMcpPresentation;
      const classifier = vi
        .spyOn(mcpPresentation, "projectMcpPresentation")
        .mockImplementation((value) => {
          const projected = original(value);
          if (projected.issues.some((issue) => issue.detail?.includes("Check retained output")))
            throw new Error("private classifier failure");
          return projected;
        });
      try {
        const result = yield* Effect.promise(() =>
          harness(() =>
            Promise.resolve(reply({ notices: ["Check retained output before continuing."] })),
          ).run(),
        );
        expect(result.details?.compactAttention?.incomplete).toBe(true);
        const projected = summary(result.details);
        expect(projected?.children?.entries[0]?.status).toBe("uncertain");
        expect(projected?.outcome).toBe("warning");
        expect(projected?.issues?.map((issue) => issue.code)).toEqual(["incomplete"]);
        expect(yield* encode(result.details)).not.toContain("private classifier failure");
      } finally {
        classifier.mockRestore();
      }
    }),
  );

  it.effect("publishes detached frozen evidence and retains it through outer failure", () =>
    Effect.gen(function* () {
      const h = harness(() =>
        Promise.resolve(reply({ notices: ["Keep this recovery instruction"] })),
      );
      const snapshots: NonNullable<CodeModeToolDetails["compactAttention"]>[] = [];
      yield* Effect.promise(() =>
        expect(
          h.run('await tools.mcp.request({action:"status"}); throw "outer failure"', (partial) => {
            const evidence = partial.details?.compactAttention;
            if (evidence) {
              snapshots.push(evidence);
              // Simulate a host replacing the evidence object in its own published snapshot.
              Object.assign(partial.details!, { compactAttention: {} });
            }
          }),
        ).rejects.toThrow(),
      );
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) expect(Object.isFrozen(snapshot)).toBe(true);
      expect(new Set(snapshots).size).toBe(snapshots.length);
      const retained = h.retention.consume("call");
      expect(retained?.compactAttention).toEqual({ ...COMPLETE_LEDGER, warnings: 1 });
      const projected = summary(retained, true);
      expect(projected?.outcome).toBe("error");
      expect(
        projected?.children?.entries.some((child) =>
          child.issues?.some((issue) =>
            `${issue.message}\n${issue.detail ?? ""}`.includes("Keep this"),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect.each(["unknown", "completed"] as const)(
    "counts an early %s error after history eviction",
    (outcome) =>
      Effect.gen(function* () {
        let count = 0;
        const result = yield* Effect.promise(() =>
          harness(() =>
            Promise.resolve(
              ++count === 1
                ? reply({ outcome, isError: true, notices: ["Early recovery evidence"] })
                : reply(),
            ),
          ).run('for(let i=0;i<270;i++) await tools.mcp.request({action:"status"}); return 1'),
        );
        expect(result.details?.compactAttention).toEqual({
          ...COMPLETE_LEDGER,
          ...(outcome === "unknown" ? { uncertain: 1 } : { errors: 1 }),
        });
        const projected = summary(result.details);
        expect(projected?.children?.entries.every((child) => child.status === "success")).toBe(
          true,
        );
        expect(projected?.outcome).toBe("warning");
      }),
  );

  it.effect("retains result IDs with truncated output and keeps pending calls compact", () =>
    Effect.gen(function* () {
      const started = deferredPromise();
      const finish = deferredPromise<McpCodeModeOutput>();
      const updates: CodeModeToolDetails[] = [];
      const pending = harness(() => {
        started.resolve();
        return finish.promise;
      }).run(undefined, (result) => {
        if (result.details) updates.push(result.details);
      });
      yield* Effect.promise(() => started.promise);
      const running = updates.findLast((details) => details.counts?.running === 1);
      expect(summary(running, false, "running")?.children?.entries[0]?.status).toBe("running");
      finish.resolve(
        reply({ resultId: "retained-123", data: { truncated: true, text: "partial" } }),
      );
      const result = yield* Effect.promise(() => pending);
      expect(summary(result.details)?.outcome).toBe("warning");
      expect(
        summary(result.details)?.children?.entries.some((child) =>
          child.issues?.some((issue) => issue.detail?.includes("retained-123")),
        ),
      ).toBe(true);
    }),
  );

  it.effect("retains cancellation uncertainty and ignores late provider completion", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const finish = deferredPromise<McpCodeModeOutput>();
      const h = harness(() => {
        controller.abort();
        return finish.promise;
      });
      const result = yield* Effect.promise(() => h.run(undefined, undefined, controller.signal));
      expect(result.details?.cancelled).toBe(true);
      expect(summary(result.details)?.outcome).toBe("cancelled");
      const before = structuredClone(result.details);
      finish.resolve(reply());
      yield* Effect.promise(() => Promise.resolve());
      expect(result.details).toEqual(before);
    }),
  );
});
