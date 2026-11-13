import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { assert, describe, expect } from "vitest";
import { sessionReportArchive } from "../../src/boundary/report-archive.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { proposalGuidance } from "../../src/tools/format.ts";
import {
  fakeEventBackendLayer,
  eventBackendRequest,
  eventBackendServiceFixture,
  runView,
} from "../run/fixtures/service-harness.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { temporaryDirectory } from "../workspace/fixtures/repository.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  managedToolHost,
  observedCall,
  receiptFor,
  resultText,
  view,
} from "./fixtures/tool-harness.ts";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const ARCHIVE_PATH = `/home/user/.pi/agent/subagents/reports/session-1/agent-1-1-${Fn.pipe("a", Str.repeat(36))}.md`;
const REPORT_FILE = { path: ARCHIVE_PATH, chars: 500_000, lines: 40_000, complete: true };

/** A run that saved a report longer than it retains, so its copy is cut. */
const reportedRun = (): SubagentRunView =>
  view({
    id: "agent-1",
    state: "completed",
    reportGeneration: 1,
    writeIntent: "writer",
    writerWorkspaceMode: "worktree",
    workspaceId: "ws-1",
    workspaceOutcome: { status: "proposal", changedFileCount: 2 },
    warning: "Disk nearly full.",
    warningSource: "child",
    finalText: "RETAINED REPORT BODY",
    finalTextTruncation: {
      retainedChars: 20,
      originalChars: REPORT_FILE.chars,
      originalLines: REPORT_FILE.lines,
    },
    reportArchive: REPORT_FILE,
  });

const SHORT_REPORT = "Short finding: the parser drops trailing commas.";
const SHORT_FILE = {
  path: `${ARCHIVE_PATH}.short`,
  chars: SHORT_REPORT.length,
  lines: 1,
  complete: true,
};

const shortReportRun = (overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({
    id: "agent-2",
    state: "completed",
    reportGeneration: 1,
    finalText: SHORT_REPORT,
    reportArchive: SHORT_FILE,
    ...overrides,
  });

describe("await report delivery", () => {
  effectTest("delivers and consumes a cut report as its file, keeping the card", function* () {
    const run = reportedRun();
    const consumed: Array<{ readonly id: string }> = [];
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use([{ run, completionReceipt: receiptFor(run.id) }]),
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
    expect(text).toContain(ARCHIVE_PATH);
    expect(text).not.toContain("RETAINED REPORT BODY");
    expect(text).toContain("Disk nearly full.");
    expect(text).toContain(proposalGuidance("ws-1", run.workspaceOutcome));
    const contract = decodeSubagentContract("agent_await")(response.structuredContent);
    const [target] = contract?.targets ?? [];
    expect(target?.report).toEqual({ status: "delivered", ...REPORT_FILE });
    expect(JSON.stringify(contract)).not.toContain("RETAINED REPORT BODY");
    expect(Arr.map(consumed, (receipt) => receipt.id)).toEqual([run.id]);
  });

  effectTest("inlines a short saved report after the blocks and keeps its file line", function* () {
    const run = shortReportRun();
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use([{ run, completionReceipt: receiptFor(run.id) }]),
        consumeCompletions: () => Effect.void,
      }),
    ).get("agent_await")!;

    const text = resultText(
      yield* step(() => executeTool(tool, { runIds: [run.id], until: "all_finished" })),
    );

    expect(text).toContain(SHORT_FILE.path);
    expect(text).toContain(SHORT_REPORT);
    // The inline copy follows the block, which still names the file.
    expect(Option.getOrElse(Fn.pipe(text, Str.indexOf(SHORT_FILE.path)), () => -1)).toBeLessThan(
      Option.getOrElse(Fn.pipe(text, Str.indexOf(SHORT_REPORT)), () => -1),
    );
  });

  effectTest("inlines no report the result only shows as delivered earlier", function* () {
    const run = shortReportRun({ reportStatus: "delivered" });
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run }]),
      }),
    ).get("agent_await")!;

    const text = resultText(
      yield* step(() => executeTool(tool, { runIds: [run.id], until: "all_finished" })),
    );

    expect(text).not.toContain(SHORT_REPORT);
  });

  effectTest("agent_read returns a saved report's retained text beside its file", function* () {
    for (const run of [shortReportRun(), reportedRun()]) {
      const tool = captureSubagentTools(
        subagentServiceDouble({
          agentRead: () =>
            Effect.succeed({
              agents: [
                {
                  kind: "run",
                  id: run.id,
                  name: run.name,
                  state: run.state,
                  textStatus: "text",
                  text: run.finalText,
                  truncated: run.finalTextTruncation !== undefined,
                  source: "report",
                  reportFile: run.reportArchive,
                  reportGeneration: 1,
                  run,
                },
              ],
              missingIds: [],
            }),
        }),
      ).get("agent_read")!;

      const response = yield* step(() => executeTool(tool, { agentIds: [run.id] }));

      const text = resultText(response);
      expect(text).toContain(run.reportArchive?.path);
      expect(text).toContain(run.finalText);
      const contract = decodeSubagentContract("agent_read")(response.structuredContent);
      expect(contract?.agents[0]).toMatchObject({
        text: run.finalText,
        reportFile: run.reportArchive,
        truncated: run.finalTextTruncation !== undefined,
      });
    }
  });
});

it.live("delivers every report file of a full await even when warnings fill the result", () =>
  Effect.gen(function* () {
    const agentDirectory = yield* temporaryDirectory("await-report-file-");
    const fixture = eventBackendServiceFixture(fakeEventBackendLayer(), {
      archiveReport: sessionReportArchive(agentDirectory, "session-1"),
    });
    const { tools, runtime, service } = yield* managedToolHost(fixture);
    const runs = yield* Effect.forEach(Array.from({ length: 12 }), (_, index) =>
      step(() =>
        runtime.run(service.startSessionOwned(eventBackendRequest({ name: `worker-${index}` }))),
      ),
    );
    const runIds = Arr.map(runs, (run) => run.id);
    const tool = tools.get("agent_await")!;
    const pending = observedCall(tool, { runIds, until: "all_finished" }, { callID: "full-await" });
    yield* pending.observing;
    // Twelve 6,000-character warnings exceed the result on their own, so cards must be clipped.
    const warning = Arr.join(
      Array.from({ length: 2_000 }, (_, word) => `w${word % 10}`),
      " ",
    );
    Arr.forEach(fixture.backend.controls, (control, index) => {
      control.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: `warning-${index}`,
        kind: "warning",
        message: Fn.pipe(warning, Str.slice(0, 6_000)),
      });
      control.complete(`Report ${index}.`);
    });
    const result = yield* pending.result;

    const text = resultText(result);
    const contract = decodeSubagentContract("agent_await")(result.structuredContent);
    for (const [index, id] of runIds.entries()) {
      const archive = (yield* step(() => runtime.run(runView(service, id)))).reportArchive;
      expect(archive).toBeDefined();
      expect(text).toContain(archive?.path);
      expect(contract?.targets[index]?.report).toEqual({ status: "delivered", ...archive });
    }

    const repeated = yield* step(() =>
      executeTool(tool, { runIds, until: "all_finished" }, { callID: "repeat-await" }),
    );
    const repeatedContract = decodeSubagentContract("agent_await")(repeated.structuredContent);
    assert(repeatedContract !== undefined);
    expect(Arr.map(repeatedContract.targets, (target) => target.report)).toEqual(
      Arr.map(runIds, () => ({ status: "already_delivered" })),
    );
    // The await consumed every report, so none reaches the parent again as a notice.
    yield* Effect.sleep(Duration.millis(200));
    expect(Arr.filter(fixture.notifications, (item) => item.type === "completed")).toHaveLength(0);
  }).pipe(Effect.scoped),
);
