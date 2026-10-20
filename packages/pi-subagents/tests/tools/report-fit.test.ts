import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../../src/run/limits.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { MAX_FINAL_TEXT_CHARS } from "../../src/run/state.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { proposalGuidance } from "../../src/tools/format.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";

const resultText = (result: {
  readonly content: ReadonlyArray<AgentToolResult<unknown>["content"][number]>;
}): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const ARCHIVE_PATH = `/home/user/.pi/agent/subagents/reports/session-1/agent-1-1-${"a".repeat(36)}.md`;
const longPath = (index: number) => `src/${"deeply/nested/".repeat(20)}module-${index}.ts`;

// Every diagnostic at or past its bound, beside a whole report at the in-memory cap.
const worstCaseRun = (): SubagentRunView => {
  const base = view();
  return view({
    id: "agent-1",
    name: "w".repeat(80),
    state: "completed",
    reportGeneration: 1,
    writeIntent: "writer",
    writerWorkspaceMode: "worktree",
    workspaceId: "ws-1",
    cwd: `/elsewhere/${"segment/".repeat(500)}worktree`,
    workspaceOutcome: {
      status: "proposal",
      changedFileCount: 25,
      diffStat: {
        addedLines: 2_000,
        deletedLines: 400,
        files: Array.from({ length: 20 }, (_, index) => ({
          path: longPath(index),
          addedLines: 100,
          deletedLines: 20,
        })),
      },
    },
    selection: { ...base.selection, warning: `Route warning ${"r".repeat(4_000)}` },
    cleanup: {
      disposition: "quarantined",
      recovery: "stop",
      diagnostic: { phase: "process-group", code: "group_live", message: "d".repeat(1_024) },
    },
    writerCleanupQuarantined: true,
    warning: `Child warning ${"c".repeat(16 * 1024)}`,
    warningSource: "child",
    systemWarning: `System warning ${"s".repeat(8 * 1024)}`,
    finalText: `${"report line\n".repeat(MAX_FINAL_TEXT_CHARS / 12)}REPORT_END`.slice(
      -MAX_FINAL_TEXT_CHARS,
    ),
    finalTextTruncation: {
      retainedChars: MAX_FINAL_TEXT_CHARS,
      originalChars: 500_000,
      originalLines: 40_000,
    },
    reportArchive: { path: ARCHIVE_PATH, lines: 40_000, complete: true },
  });
};

describe("report fitting", () => {
  effectTest("a lone await delivers a whole report beside oversized diagnostics", function* () {
    const run = worstCaseRun();
    expect(run.finalText?.length).toBe(MAX_FINAL_TEXT_CHARS);
    const consumed: Array<{ readonly id: string }> = [];
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use([{ run, completionReceipt: { id: run.id, generation: 1, claimToken: "claim" } }]),
        consumeCompletions: (receipts) =>
          Effect.sync(() => {
            consumed.push(...receipts);
          }),
      }),
    ).get("agent_await")!;

    const response = yield* step(() =>
      executeTool(tool, { runIds: [run.id], until: "all_finished" }),
    );

    const text = resultText(response);
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(text).toContain(run.finalText);
    expect(text).toContain(proposalGuidance("ws-1", run.workspaceOutcome));
    expect(text).toContain(ARCHIVE_PATH);
    const contract = decodeSubagentContract("agent_await")(response.structuredContent);
    const [target] = contract?.targets ?? [];
    expect(target?.report).toEqual({ status: "delivered", text: run.finalText });
    expect(target?.reportArchive?.path).toBe(ARCHIVE_PATH);
    expect(consumed.map((receipt) => receipt.id)).toEqual([run.id]);
  });

  effectTest("an ordinary card is not shortened", function* () {
    const run = view({ id: "agent-1", state: "completed", finalText: "Short report." });
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use([
            {
              run: { ...run, warning: "Disk nearly full." },
              completionReceipt: { id: run.id, generation: 1, claimToken: "claim" },
            },
          ]),
        consumeCompletions: () => Effect.void,
      }),
    ).get("agent_await")!;

    const response = yield* step(() =>
      executeTool(tool, { runIds: [run.id], until: "all_finished" }),
    );

    const text = resultText(response);
    expect(text).toContain("Disk nearly full.");
    expect(text).toContain("Short report.");
  });
});
