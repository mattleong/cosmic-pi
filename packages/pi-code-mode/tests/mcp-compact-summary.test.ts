import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { isCompactAttention } from "pi-code-previews";
import * as mcpPresentation from "pi-mcp/code-mode";
import {
  projectMcpCompactSummary,
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeQuery,
  mcpCodeModeError,
  type McpCodeModeCapability,
  type McpCodeModeOutput,
} from "pi-mcp/code-mode";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { makeFailureDetailsRetention } from "../src/tools/retention.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
const summary = <Details>(
  details: Details,
  isError = false,
  phase: "running" | "settled" = "settled",
) =>
  codeModeCompactSummary({
    phase,
    args: { intent: "Inspect MCP" },
    result: { details, content: [{ type: "text", text: "Guest discarded the MCP payload" }] },
    context: opaqueHostFixture({ isError }),
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
  const events = createEventBus();
  events.on(MCP_CODE_MODE_QUERY, (value) =>
    normalizeMcpCodeModeQuery(value)?.respond({
      version: MCP_CODE_MODE_VERSION,
      sessionId: "compact-mcp",
      execute: provider,
    }),
  );
  const retention = makeFailureDetailsRetention();
  const state = codeModeStateFixture({
    maxToolCalls: 400,
    maxOutputBytes,
    maxCumulativeChildOutputBytes: 1000000,
  });
  const execute = makeCodeModeToolExecute({
    isCurrent: () => true,
    getState: () => state,
    runInSession: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
    definitions: nestedToolDefinitionsFixture({}),
    events,
    sessionId: "compact-mcp",
    retainFailureDetails: retention.retain,
  });
  return {
    retention,
    run: (
      code = 'await tools.mcp.request({action:"status"}); return "discarded"',
      onUpdate?: Parameters<typeof execute>[3],
      signal?: AbortSignal,
    ) => execute("test", { code }, signal, onUpdate, extensionContextFixture({})),
  };
};
describe("MCP execution evidence in compact Code Mode results", () => {
  it.effect(
    "uses the same discovery notice relevance standalone and nested without resurrecting routine attention",
    () =>
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
        expect(summary(completed.details)?.outcome).toBe(standalone?.outcome);
        expect(
          completed.details?.toolCalls[0]?.compact?.notices.map((notice) => ({
            text: notice.text,
            expandedOnly: notice.expandedOnly,
          })),
        ).toEqual(
          standalone?.notices?.map((notice) => ({
            text: notice.text,
            expandedOnly: notice.expandedOnly,
          })),
        );
        expect(completed.details?.mcpEvidence).toBeUndefined();
        expect(completed.details?.compactAttention?.notices).toEqual([]);
        expect(summary(completed.details)?.notices?.filter(isCompactAttention)).toEqual([]);
        expect(
          mcpPresentation.projectMcpPresentation({
            ...output,
            notices: [...output.notices, "Check remote state."],
          }).notices,
        ).toContain("Check remote state.");
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
        expect(mcpPresentation.projectMcpPresentation(discovery).notices).toEqual(
          direct?.notices?.map((notice) => notice.text),
        );
      }),
  );
  it.effect.each([
    [reply(), "success"],
    [reply({ isError: true }), "error"],
    [reply({ outcome: "unknown" }), "uncertain"],
    [reply({ outcome: "not-sent" }), "warning"],
    [reply({ notices: ["Inspect server access before continuing."] }), "warning"],
    [reply({ data: { result: { undiscovered: ["server"] } } }), "warning"],
    [reply({ data: { result: { truncated: true } } }), "warning"],
  ] as const)("uses validated envelopes independently of guest output: %j", ([output, outcome]) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => harness(() => Promise.resolve(output)).run());
      const projected = summary(result.details);
      expect(projected?.outcome).toBe(outcome);
      expect(projected?.children?.entries).toMatchObject([{ label: "mcp", status: outcome }]);
      expect(projected?.detailsOnExpand).toBe(true);
      expect(projected?.failure).toBeUndefined();
      // Detailed rendering owns retained MCP attention, so the shell must not append it again.
      expect(projected?.notices?.every((notice) => notice.expandedInResult === true)).toBe(true);
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
  ] as const)("does not promote retained read success over its origin: %j", ([origin, outcome]) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() =>
          Promise.resolve(
            reply({ action: "result.read", data: origin === undefined ? {} : { origin } }),
          ),
        ).run('await tools.mcp.request({action:"result.read",id:"retained"}); return 1'),
      );
      expect(summary(result.details)?.outcome).toBe(outcome);
      expect(summary(result.details)?.children?.entries).toMatchObject([
        { label: "mcp", status: outcome },
      ]);
    }),
  );
  it.effect.each([
    [mcpCodeModeError("output-limit", "completed"), "error"],
    [mcpCodeModeError("unavailable", "not-sent"), "error"],
    [new Error("SECRET_CREDENTIAL"), "uncertain"],
  ] as const)("retains caught rejection certainty without raw errors", ([error, outcome]) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.reject(error)).run(
          'try { await tools.mcp.request({action:"status"}); } catch {} return 1',
        ),
      );
      expect(summary(result.details)?.outcome).toBe(outcome);
      expect(
        result.details?.compactAttention?.notices.map((notice) => notice.text).join("\n"),
      ).not.toContain("SECRET_CREDENTIAL");
      expect(result.details?.counts?.failed).toBe(1);
      expect(summary(result.details)?.children?.entries).toMatchObject([
        { label: "mcp", status: outcome },
      ]);
    }),
  );
  it.effect("joins parallel mixed outcomes without last-call-wins state", () =>
    Effect.gen(function* () {
      const finishers: Array<(value: McpCodeModeOutput) => void> = [];
      let ready: (() => void) | undefined;
      const started = Effect.runPromise(
        Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          ready = resolve;
        }),
      );
      const pending = harness(() =>
        Effect.runPromise(
          Effect.callback<McpCodeModeOutput>((resume) => {
            const resolve = (value: McpCodeModeOutput) => resume(Effect.succeed(value));
            finishers.push(resolve);
            if (finishers.length === 3) ready?.();
          }),
        ),
      ).run('await Promise.all([1,2,3].map(() => tools.mcp.request({action:"status"}))); return 1');
      yield* Effect.promise(() => started);
      finishers[2]!(reply());
      finishers[1]!(reply({ outcome: "unknown" }));
      finishers[0]!(reply());
      const result = yield* Effect.promise(() => pending);
      expect(result.details?.compactAttention).toMatchObject({
        observed: 3,
        uncertain: 1,
        errors: 0,
      });
      expect(summary(result.details)?.outcome).toBe("uncertain");
      expect(summary(result.details)?.children?.entries).toMatchObject([
        { label: "mcp", status: "success" },
        { label: "mcp", status: "uncertain" },
        { label: "mcp", status: "success" },
      ]);
    }),
  );
  it.effect.each([40, 270])("covers %i calls beyond visible and tracked history", (count) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.resolve(reply())).run(
          `for (let i=0;i<${count};i++) await tools.mcp.request({action:"status"}); return 1`,
        ),
      );
      expect(result.details?.toolCalls).toHaveLength(32);
      expect(summary(result.details)?.children?.total).toBe(count);
      expect(summary(result.details)?.children?.entries).toHaveLength(
        result.details!.toolCalls.length,
      );
      expect(result.details?.compactAttention?.observed).toBe(count);
      expect(summary(result.details)?.outcome).toBe("success");
    }),
  );
  it.effect("does not lose hidden unsupported calls", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() => Promise.resolve(reply())).run(
          'try { await tools.session.backgroundTask({action:"list"}); } catch {} for (let i=0;i<270;i++) await tools.mcp.request({action:"status"}); return 1',
        ),
      );
      expect(result.details?.compactAttention?.incomplete).toBe(true);
      expect(summary(result.details)?.outcome).toBe("uncertain");
      expect(
        summary(result.details)?.notices?.some((notice) => notice.text.includes("incomplete")),
      ).toBe(true);
    }),
  );
  it.effect(
    "declines malformed, missing and incomplete evidence without using a legacy success path",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => harness(() => Promise.resolve(reply())).run());
        const evidence = {
          version: 1,
          pi: 0,
          mcp: 1,
          unsupported: 0,
          observed: 1,
          completed: 1,
          errors: 0,
          unknown: 0,
          notSent: 0,
          incomplete: false,
          notices: [],
        }; // Historical dual-ledger result.
        for (const mcpEvidence of [
          null,
          {},
          { ...evidence, observed: 0 },
          { ...evidence, version: 2 },
          { ...evidence, incomplete: true },
          { ...evidence, errors: Number.MAX_SAFE_INTEGER + 1 },
        ])
          expect(summary({ ...result.details, mcpEvidence })?.outcome).toBe("uncertain");
        expect(
          summary({ ...result.details, compactAttention: undefined, mcpEvidence: undefined }),
        ).toBeUndefined();
      }),
  );
  it.effect("retains validated notices when outcome classification fails", () =>
    Effect.gen(function* () {
      const original = mcpPresentation.projectMcpPresentation;
      const classifier = vi
        .spyOn(mcpPresentation, "projectMcpPresentation")
        .mockImplementation((value) => {
          const projected = original(value);
          if (projected.notices.includes("Check retained output before continuing."))
            throw new Error("private classifier failure");
          return projected;
        });
      try {
        const result = yield* Effect.promise(() =>
          harness(() =>
            Promise.resolve(reply({ notices: ["Check retained output before continuing."] })),
          ).run(),
        );
        expect(result.details?.compactAttention).toMatchObject({
          incomplete: true,
          notices: [{ text: "Check retained output before continuing." }],
        });
        expect(summary(result.details)?.outcome).toBe("uncertain");
      } finally {
        classifier.mockRestore();
      }
    }),
  );
  it.effect("declines notice overflow rather than dropping recovery evidence", () =>
    Effect.gen(function* () {
      let count = 0;
      const result = yield* Effect.promise(() =>
        harness(() => Promise.resolve(reply({ notices: [`Recovery instruction ${++count}`] }))).run(
          'for(let i=0;i<40;i++) await tools.mcp.request({action:"status"}); return 1',
        ),
      );
      expect(result.details?.compactAttention?.notices).toHaveLength(32);
      expect(summary(result.details)?.outcome).toBe("uncertain");
      expect(
        summary(result.details)?.notices?.some((notice) => notice.text.includes("warning limit")),
      ).toBe(true);
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
      for (const snapshot of snapshots) {
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.notices)).toBe(true);
      }
      expect(new Set(snapshots).size).toBe(snapshots.length);
      const retained = h.retention.consume("test");
      expect(retained?.compactAttention?.observed).toBe(1);
      expect(
        summary(retained, true)?.children?.entries.some((child) =>
          child.notices?.some((notice) => notice.text.includes("Keep this")),
        ),
      ).toBe(true);
    }),
  );
  it.effect.each(["unknown", "completed"] as const)(
    "retains early %s errors after history eviction",
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
        expect(summary(result.details)?.outcome).toBe(
          outcome === "unknown" ? "uncertain" : "error",
        );
        expect(
          summary(result.details)?.issues?.entries.some((issue) =>
            issue.cause.includes("Early recovery"),
          ),
        ).toBe(true);
      }),
  );
  it.effect("retains result IDs with truncated output and keeps pending calls compact", () =>
    Effect.gen(function* () {
      let ready: (() => void) | undefined;
      const started = Effect.runPromise(
        Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          ready = resolve;
        }),
      );
      let finish: ((value: McpCodeModeOutput) => void) | undefined;
      const updates: CodeModeToolDetails[] = [];
      const pending = harness(() =>
        Effect.runPromise(
          Effect.callback<McpCodeModeOutput>((resume) => {
            const resolve = (value: McpCodeModeOutput) => resume(Effect.succeed(value));
            finish = resolve;
            ready?.();
          }),
        ),
      ).run(undefined, (result) => {
        if (result.details) updates.push(result.details);
      });
      yield* Effect.promise(() => started);
      const running = updates.findLast((details) => details.counts?.running === 1);
      expect(summary(running, false, "running")).toBeDefined();
      expect(summary(running)?.outcome).toBe("uncertain");
      finish?.(reply({ resultId: "retained-123", data: { truncated: true, text: "partial" } }));
      const result = yield* Effect.promise(() => pending);
      expect(summary(result.details)?.outcome).toBe("warning");
      expect(
        summary(result.details)?.children?.entries.some((child) =>
          child.notices?.some((notice) => notice.text.includes("retained-123")),
        ),
      ).toBe(true);
    }),
  );
  it.effect("does not downgrade an unknown read envelope to its not-sent origin", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        harness(() =>
          Promise.resolve(
            reply({
              action: "result.read",
              outcome: "unknown",
              data: { origin: { outcome: "not-sent", isError: false } },
            }),
          ),
        ).run('await tools.mcp.request({action:"result.read",id:"old"}); return 1'),
      );
      expect(summary(result.details)?.outcome).toBe("uncertain");
    }),
  );
  it.effect("retains cancellation uncertainty and ignores late provider completion", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      let finish: ((value: McpCodeModeOutput) => void) | undefined;
      const h = harness(() =>
        Effect.runPromise(
          Effect.callback<McpCodeModeOutput>((resume) => {
            const resolve = (value: McpCodeModeOutput) => resume(Effect.succeed(value));
            finish = resolve;
            controller.abort();
          }),
        ),
      );
      const result = yield* Effect.promise(() => h.run(undefined, undefined, controller.signal));
      expect(result.details?.cancelled).toBe(true);
      expect(summary(result.details)?.outcome).not.toBe("success");
      const before = structuredClone(result.details);
      finish?.(reply());
      yield* Effect.promise(() => Promise.resolve());
      expect(result.details).toEqual(before);
    }),
  );
});
