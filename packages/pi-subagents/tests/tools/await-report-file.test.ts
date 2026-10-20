import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import { sessionReportArchive } from "../../src/boundary/report-archive.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../../src/run/limits.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import { SubagentService } from "../../src/run/service.ts";
import { MAX_ERROR_CHARS } from "../../src/run/state.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { proposalGuidance } from "../../src/tools/format.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import {
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  runView,
} from "../run/fixtures/service-harness.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { temporaryDirectory } from "../workspace/fixtures/repository.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";

const resultText = (result: {
  readonly content: ReadonlyArray<AgentToolResult<unknown>["content"][number]>;
}): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const ARCHIVE_PATH = `/home/user/.pi/agent/subagents/reports/session-1/agent-1-1-${"a".repeat(36)}.md`;
const REPORT_FILE = { path: ARCHIVE_PATH, chars: 500_000, lines: 40_000, complete: true };

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
    reportArchive: REPORT_FILE,
  });

describe("await report delivery", () => {
  effectTest("delivers and consumes a saved report as its file, keeping the card", function* () {
    const run = reportedRun();
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
    expect(text).toContain(ARCHIVE_PATH);
    expect(text).not.toContain("RETAINED REPORT BODY");
    expect(text).toContain("Disk nearly full.");
    expect(text).toContain(proposalGuidance("ws-1", run.workspaceOutcome));
    const contract = decodeSubagentContract("agent_await")(response.structuredContent);
    const [target] = contract?.targets ?? [];
    expect(target?.report).toEqual({ status: "delivered", ...REPORT_FILE });
    expect(JSON.stringify(contract)).not.toContain("RETAINED REPORT BODY");
    expect(consumed.map((receipt) => receipt.id)).toEqual([run.id]);
  });
});

/** Text tagged so a test can tell a whole outcome from a partial one. */
const tagged = (tag: string): string => `${tag}:${"x".repeat(MAX_ERROR_CHARS - tag.length - 2)}.`;

const receipt = (id: string) => ({ id, generation: 1, claimToken: `claim-${id}` });

/** Awaits observations through a double that acknowledges only the questions the await covered. */
const awaitObservations = (observations: ReadonlyArray<SubagentRunObservation>) =>
  Effect.gen(function* () {
    const consumed: Array<string> = [];
    const acknowledged: Array<string> = [];
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use, questionCoverage) =>
          use(observations).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                const covered = questionCoverage?.(result);
                acknowledged.push(
                  ...observations.flatMap(({ run, questionReceipt }) =>
                    questionReceipt && covered?.has(run.id) ? [run.id] : [],
                  ),
                );
              }),
            ),
          ),
        consumeCompletions: (receipts) =>
          Effect.sync(() => {
            consumed.push(...receipts.map((item) => item.id));
          }),
      }),
    ).get("agent_await")!;
    const response = yield* step(() =>
      executeTool(tool, {
        runIds: observations.map(({ run }) => run.id),
        until: "all_finished",
      }),
    );
    return {
      text: resultText(response),
      contract: decodeSubagentContract("agent_await")(response.structuredContent),
      consumed,
      acknowledged,
    };
  });

describe("await outcome reservation", () => {
  effectTest("pending reports outlast long diagnostics and consumed failures", function* () {
    const consumedFailures = Array.from({ length: 5 }, (_, index) => ({
      run: view({
        id: `failed-${index}`,
        state: "failed",
        reportStatus: "delivered",
        error: tagged(`OLD-FAILURE-${index}`),
        warning: tagged(`WARNING-${index}`),
      }),
    }));
    const pendingReports = Array.from({ length: 6 }, (_, index) => {
      const id = `done-${index}`;
      const reportFile = { ...REPORT_FILE, path: `${ARCHIVE_PATH}.${index}` };
      return {
        run: view({
          id,
          state: "completed",
          reportGeneration: 1,
          warning: tagged(`WARNING-${id}`),
          finalText: "REPORT BODY",
          reportArchive: reportFile,
        }),
        completionReceipt: receipt(id),
      };
    });

    // Listed after the failures, whose outcomes alone would fill the room it needs.
    const inlineReport = {
      run: view({
        id: "inline",
        state: "completed",
        reportGeneration: 1,
        finalText: tagged("INLINE-REPORT"),
      }),
      completionReceipt: receipt("inline"),
    };
    const pending = [inlineReport, ...pendingReports];

    const { text, contract, consumed } = yield* awaitObservations([
      ...consumedFailures,
      ...pending,
    ]);

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(text).toContain(inlineReport.run.finalText);
    for (const { run } of pendingReports) expect(text).toContain(run.reportArchive?.path);
    expect(consumed).toEqual(pending.map(({ run }) => run.id));
    expect(
      contract?.targets.slice(consumedFailures.length).map((target) => target.report.status),
    ).toEqual(pending.map(() => "delivered"));
  });

  effectTest("an outcome that doesn't fit is withheld whole and stays pending", function* () {
    const failures = Array.from({ length: 11 }, (_, index) => ({
      run: view({ id: `failed-${index}`, state: "failed", error: tagged(`FAILURE-${index}`) }),
      completionReceipt: receipt(`failed-${index}`),
    }));
    const question = {
      run: view({
        id: "asking",
        state: "waiting_for_parent",
        question: { requestId: "q-1", message: tagged("QUESTION") },
      }),
      questionReceipt: { ...receipt("asking"), requestId: "q-1" },
    };

    const { text, contract, consumed, acknowledged } = yield* awaitObservations([
      ...failures,
      question,
    ]);

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    const shown = failures.filter(({ run }) => text.includes(run.error ?? ""));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(failures.length);
    for (const [index, { run }] of failures.entries()) {
      const whole = shown.some((item) => item.run.id === run.id);
      // An outcome is never cut: a withheld failure leaves no part of itself behind.
      if (!whole) expect(text).not.toContain(`FAILURE-${index}:`);
      expect(contract?.targets[index]?.report.status).toBe(whole ? "missing" : "deferred");
    }
    expect(consumed).toEqual(shown.map(({ run }) => run.id));
    expect(text).not.toContain(question.run.question?.message);
    expect(acknowledged).toEqual([]);
  });
});

it.live("delivers every report file of a full await even when warnings fill the result", () =>
  Effect.gen(function* () {
    const agentDirectory = yield* temporaryDirectory("await-report-file-");
    const fixture = nativeReportServiceFixture(fakeNativeReportBackendLayer(), {
      archiveReport: sessionReportArchive(agentDirectory, "session-1"),
    });
    const { pi, tools } = recordingExtensionHost();
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer)),
      ),
      (owned) => step(() => owned.dispose()),
    );
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: true },
      run: (effect, signal) => runtime.run(effect, signal),
    });
    const service = yield* step(() => runtime.run(SubagentService));
    const runs = yield* Effect.forEach(Array.from({ length: 12 }), (_, index) =>
      step(() =>
        runtime.run(service.startSessionOwned(nativeReportRequest({ name: `worker-${index}` }))),
      ),
    );
    const runIds = runs.map((run) => run.id);
    const tool = tools.get("agent_await")!;
    const claimed = Deferred.makeUnsafe<void>();
    const pending = executeTool(
      tool,
      { runIds, until: "all_finished" },
      { callID: "full-await", update: () => Deferred.doneUnsafe(claimed, Effect.void) },
    );
    yield* Deferred.await(claimed);
    // Twelve 6,000-character warnings exceed the result on their own, so cards must be clipped.
    const warning = Array.from({ length: 2_000 }, (_, word) => `w${word % 10}`).join(" ");
    fixture.backend.controls.forEach((control, index) => {
      control.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: `warning-${index}`,
        kind: "warning",
        message: warning.slice(0, 6_000),
      });
      control.report(runIds[index]!, 1, `delivery-${index}`, `Report ${index}.`);
    });
    const result = yield* step(() => pending);

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
    expect(repeatedContract?.targets.map((target) => target.report)).toEqual(
      runIds.map(() => ({ status: "already_delivered" })),
    );
    // The await consumed every report, so none reaches the parent again as a notice.
    yield* Effect.sleep(Duration.millis(200));
    expect(fixture.notifications.filter((item) => item.type === "completed")).toHaveLength(0);
  }).pipe(Effect.scoped),
);
