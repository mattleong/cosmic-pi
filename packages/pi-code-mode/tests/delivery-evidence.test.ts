import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeQuery,
  type McpCodeModeOutput,
} from "pi-mcp/code-mode";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { CodeMode } from "../src/boundary/codemode-runtime.ts";
import { makeCompactEvidence, type CompactReceipt } from "../src/tools/compact-evidence.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { renderCodeModeToolResult } from "../src/ui/tool-renderer.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const recovery = (receipt: CompactReceipt) =>
  receipt.notices.filter((notice) => notice.text.includes("do not replay"));

describe("interpreter delivery evidence", () => {
  it.effect(
    "records protocol-valid output rejected at the interpreter depth boundary without changing operation outcome",
    () =>
      Effect.gen(function* () {
        let data: McpCodeModeOutput["data"] = null;
        for (let depth = 0; depth < 40; depth++) data = { child: data };
        const events = createEventBus();
        events.on(MCP_CODE_MODE_QUERY, (value) =>
          normalizeMcpCodeModeQuery(value)?.respond({
            version: MCP_CODE_MODE_VERSION,
            sessionId: "delivery",
            execute: () =>
              Promise.resolve({
                action: "status",
                outcome: "completed",
                isError: false,
                data,
                notices: [],
              }),
          }),
        );
        const state = codeModeStateFixture({ maxCumulativeChildOutputBytes: 1000000 });
        for (const legacy of [false, true]) {
          const execute = makeCodeModeToolExecute({
            executeCodeMode: (options) => {
              if (!legacy) return CodeMode.execute(options);
              const { onToolCallLifecycle: _ignored, ...legacyOptions } = options;
              return CodeMode.execute(legacyOptions);
            },
            isCurrent: () => true,
            getState: () => state,
            runInSession: (effect) => Effect.runPromise(effect),
            definitions: nestedToolDefinitionsFixture({}),
            events,
            sessionId: "delivery",
          });
          const completed = yield* Effect.promise(() =>
            execute(
              "depth",
              {
                code: 'let message=""; try { await tools.mcp.request({action:"status"}); } catch(e) { message=e.message; } return message;',
              },
              undefined,
              undefined,
              extensionContextFixture({}),
            ),
          );
          expect(completed.content[0]).toMatchObject({
            text: expect.stringContaining("Invalid output"),
          });
          const receipt = completed.details!.toolCalls[0]!.compact!;
          expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
          expect(recovery(receipt)).toHaveLength(1);
          expect(completed.details!.compactAttention).toMatchObject({
            observed: 1,
            errors: 0,
            incomplete: false,
          });
          expect(completed.details!.compactAttention!.notices).toContainEqual(recovery(receipt)[0]);
        }
      }),
  );

  it("keeps individual loss explanations on visible children and hidden or evicted calls in the parent", () => {
    const receipts = new Map<number, CompactReceipt>();
    const collector = makeCompactEvidence((id, receipt) => receipts.set(id, receipt));
    for (let id = 0; id < 36; id++) {
      collector.admit("pi.read");
      collector.start(id, id);
      collector.observe(id, () => ({ subject: "same file", outcome: "success" }));
      collector.deliveryFailure(id);
      collector.deliveryFailure(id);
      collector.end(id);
    }
    collector.close();
    expect(collector.snapshot().notices).toHaveLength(32);
    expect(collector.snapshot().incomplete).toBe(true);
    for (const receipt of receipts.values()) expect(recovery(receipt)).toHaveLength(1);
    const details: CodeModeToolDetails = {
      toolCalls: [...receipts.values()]
        .slice(-32)
        .map((compact) => ({ tool: "pi.read", status: "error", compact })),
      outputKind: "text",
      totalToolCalls: 36,
      counts: { total: 36, succeeded: 0, failed: 36, cancelled: 0, running: 0, queued: 0 },
      compactAttention: collector.snapshot(),
    };
    const result = { content: [{ type: "text" as const, text: "discarded" }], details };
    const summary = codeModeCompactSummary({
      phase: "settled",
      args: {},
      result,
      context: opaqueHostFixture({ isError: false }),
    })!;
    expect(
      summary.issues?.entries.some((issue) => issue.cause === recovery(receipts.get(0)!)[0]!.text),
    ).toBe(true);
    const theme = opaqueHostFixture({
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    const expanded = renderCodeModeToolResult(result, { isPartial: false }, theme, {
      isError: false,
      expanded: true,
    })
      .component.render(240)
      .join("\n");
    for (const receipt of receipts.values()) {
      expect(expanded.split(recovery(receipt)[0]!.text)).toHaveLength(2);
    }
  });

  it("preserves existing recovery at receipt and aggregate capacity and marks overflow incomplete", () => {
    let receipt: CompactReceipt | undefined;
    const collector = makeCompactEvidence((_id, value) => {
      receipt = value;
    });
    collector.admit("pi.read");
    collector.start(1, 1);
    const notices = Array.from({ length: 32 }, (_, id) => ({
      kind: "recovery" as const,
      text: `Existing recovery ${id}`,
    }));
    collector.observe(1, () => ({ subject: "file", outcome: "success", notices }));
    collector.deliveryFailure(1);
    collector.deliveryFailure(1);
    expect(receipt).toMatchObject({ deliveryFailed: true, notices });
    expect(collector.snapshot()).toMatchObject({ incomplete: true, notices });
    expect(receipt!.notices).toHaveLength(32);
    collector.end(1);
    collector.close();
  });
});
