import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { assert, describe, expect, it, vi } from "vitest";
import {
  completionBlock,
  hostNotifier,
  type SubagentCompletionNotification,
} from "../../src/boundary/host-notifier.ts";
import { MAX_PROCESS_LINE_BYTES } from "../../src/boundary/process-transport.ts";
import {
  MAX_COMPLETION_DELIVERY_BATCH,
  MAX_CONTACT_TEXT_CHARS,
  MAX_LIFECYCLE_TARGET_RUNS,
  MAX_NOTIFICATION_CHARS,
  MAX_OUTCOME_FILE_PATH_CHARS,
  MAX_PARENT_MESSAGE_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
  MAX_TOOL_OUTPUT_CHARS,
} from "../../src/run/limits.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { runReadout } from "../../src/run/agent-messaging.ts";
import { MAX_PROFILE_MODEL_SELECTOR_CHARS } from "../../src/profiles/model.ts";
import type {
  SubagentNextCandidate,
  SubagentReportArchive,
  SubagentRunView,
} from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import { MAX_ERROR_CHARS, MAX_FINAL_TEXT_CHARS, MAX_NAME_CHARS } from "../../src/run/state.ts";
import { agentReadText } from "../../src/supervisor/agent-text.ts";
import { MAX_SUPERVISOR_MCP_AGENT_ID_CHARS } from "../../src/supervisor/mcp-contract.ts";
import { runIdFixture } from "../fixtures/run-view.ts";
import {
  MAX_SUPERVISOR_AGENT_CARD_CHARS,
  MAX_SUPERVISOR_AGENT_NAME_CHARS,
  MAX_SUPERVISOR_AGENT_READ_CHARS,
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  type SupervisorAgentReadResult,
  SupervisorRpcGroup,
} from "../../src/supervisor/protocol.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { agentReadCard } from "../../src/tools/execute-agents.ts";
import {
  formatStartResult,
  MAX_ACTION_FAILURE_LINE_CHARS,
  MAX_START_ENTRY_CHARS,
  MAX_START_HEADER_CHARS,
} from "../../src/tools/format.ts";
import type { SubagentStartFailure } from "../../src/tools/model.ts";
import {
  formatRunBlock,
  MAX_ACKNOWLEDGEMENT_BLOCK_CHARS,
  MAX_RESULT_HEADER_CHARS,
  MAX_RUN_BLOCK_CHARS,
  RUN_BLOCK_SEPARATOR,
  runViewBlock,
  runViewOutcome,
} from "../../src/tools/run-block.ts";
import { runRecordFixture } from "../run/fixtures/run-context.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const blocksNeeded = (count: number): number =>
  MAX_RESULT_HEADER_CHARS + count * (MAX_RUN_BLOCK_CHARS + RUN_BLOCK_SEPARATOR.length);

describe("model-facing output budget", () => {
  it("fits MAX_TARGET_RUNS run blocks in one tool result", () => {
    const needed = blocksNeeded(MAX_TARGET_RUNS);
    expect(
      needed,
      `${MAX_RESULT_HEADER_CHARS} header + MAX_TARGET_RUNS (${MAX_TARGET_RUNS}) × MAX_RUN_BLOCK_CHARS (${MAX_RUN_BLOCK_CHARS}) = ${needed} exceeds MAX_TOOL_OUTPUT_CHARS (${MAX_TOOL_OUTPUT_CHARS}). Lower MAX_TARGET_RUNS, or shrink the line bounds in src/tools/run-block.ts.`,
    ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(
      MAX_RESULT_HEADER_CHARS +
        MAX_LIFECYCLE_TARGET_RUNS * (MAX_ACKNOWLEDGEMENT_BLOCK_CHARS + RUN_BLOCK_SEPARATOR.length),
      "Lifecycle acknowledgement blocks for MAX_LIFECYCLE_TARGET_RUNS targets must fit one result.",
    ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(
      MAX_ACTION_FAILURE_LINE_CHARS,
      "A lifecycle failure line must fit the run block it replaces; lower MAX_ACTION_FAILURE_LINE_CHARS.",
    ).toBeLessThanOrEqual(MAX_ACKNOWLEDGEMENT_BLOCK_CHARS);
  });

  it("fits a full completion batch in one root notice and a run in a nested parent message", () => {
    const needed = blocksNeeded(MAX_COMPLETION_DELIVERY_BATCH);
    expect(
      needed,
      `${MAX_RESULT_HEADER_CHARS} header + MAX_COMPLETION_DELIVERY_BATCH (${MAX_COMPLETION_DELIVERY_BATCH}) × MAX_RUN_BLOCK_CHARS (${MAX_RUN_BLOCK_CHARS}) = ${needed} exceeds MAX_NOTIFICATION_CHARS (${MAX_NOTIFICATION_CHARS}). Lower MAX_COMPLETION_DELIVERY_BATCH, or shrink the line bounds in src/tools/run-block.ts.`,
    ).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
    expect(
      blocksNeeded(1),
      "A nested parent gets one run block per message; it must fit MAX_PARENT_MESSAGE_CHARS.",
    ).toBeLessThanOrEqual(MAX_PARENT_MESSAGE_CHARS);
  });

  it("fits a full start batch in one tool result", () => {
    const needed = MAX_START_HEADER_CHARS + MAX_START_BATCH * (MAX_START_ENTRY_CHARS + 1);
    expect(
      needed,
      `MAX_START_BATCH (${MAX_START_BATCH}) × MAX_START_ENTRY_CHARS (${MAX_START_ENTRY_CHARS}) = ${needed} exceeds MAX_TOOL_OUTPUT_CHARS (${MAX_TOOL_OUTPUT_CHARS}). Lower MAX_START_BATCH, or shrink the start line bounds in src/tools/format.ts.`,
    ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });
});

// Worst-case inputs: every field at its retained bound.

const longText = (tag: string, length: number): string =>
  Fn.pipe(
    `${tag} ${Arr.join(
      Array.from({ length }, (_, index) => `w${index % 10}`),
      " ",
    )}`,
    Str.slice(0, length),
  );

/** A real archive path is at most MAX_OUTCOME_FILE_PATH_CHARS; the archive saves nothing longer. */
const maxPath = (index: number, kind = "report"): string => {
  const file = `/${runIdFixture(index)}-${kind}-1-${Fn.pipe("u", Str.repeat(36))}.md`;
  return `/${Fn.pipe("d", Str.repeat(MAX_OUTCOME_FILE_PATH_CHARS - file.length - 1))}${file}`;
};

const archive = (path: string): SubagentReportArchive => ({
  path,
  chars: 1024 * 1024,
  lines: 1024 * 1024,
  complete: false,
});

const worstCandidate: SubagentNextCandidate = {
  runtime: "pi",
  model: Fn.pipe("m", Str.repeat(MAX_PROFILE_MODEL_SELECTOR_CHARS)),
  effort: "xhigh",
};

const worstRun = (index: number): SubagentRunView => {
  const id = runIdFixture(index);
  const common = {
    id,
    name: longText(`worker-${index}`, MAX_NAME_CHARS),
    profile: "reviewer" as const,
    agent: Fn.pipe("a", Str.repeat(64)),
    warning: longText(`WARNING-${index}`, MAX_CONTACT_TEXT_CHARS),
    parentRunId: "root",
    nextCandidate: worstCandidate,
    steeringDelivery: "unresolved" as const,
    writeIntent: "writer" as const,
    writerWorkspaceMode: "worktree" as const,
    workspaceId: Fn.pipe("w", Str.repeat(36)),
    workspaceOutcome: {
      status: "proposal" as const,
      changedFileCount: 999_999,
      uncapturedFileCount: 999_999,
      diffStat: {
        addedLines: 9_999_999,
        deletedLines: 9_999_999,
        files: Array.from({ length: 50 }, (_, file) => ({
          path: `src/${Fn.pipe("p", Str.repeat(200))}-${file}.ts`,
          addedLines: 1,
          deletedLines: 1,
        })),
      },
    },
    cleanup: {
      disposition: "quarantined" as const,
      recovery: "stop" as const,
      diagnostic: { phase: "writer-lease" as const, message: longText("cleanup", 1_024) },
    },
  };
  switch (index % 4) {
    case 0:
      return view({
        ...common,
        state: "completed",
        reportGeneration: 1,
        finalText: longText(`REPORT-${index}`, MAX_FINAL_TEXT_CHARS),
        reportArchive: archive(maxPath(index)),
      });
    case 1:
      // The archive write failed, so the block previews the retained report.
      return view({
        ...common,
        state: "completed",
        reportGeneration: 1,
        finalText: longText(`UNSAVED-${index}`, MAX_FINAL_TEXT_CHARS),
        finalTextTruncation: {
          retainedChars: MAX_FINAL_TEXT_CHARS,
          originalChars: 1024 * 1024,
          originalLines: 1024 * 1024,
        },
      });
    case 2:
      return view({
        ...common,
        state: "failed",
        error: longText(`FAILURE-${index}`, MAX_ERROR_CHARS),
        ...(index % 8 === 2 && { errorArchive: archive(maxPath(index, "failure")) }),
      });
    default:
      return view({
        ...common,
        state: "waiting_for_parent",
        question: {
          requestId: `q-${index}`,
          message: longText(`QUESTION-${index}`, MAX_CONTACT_TEXT_CHARS),
        },
      });
  }
};

const worstObservations = (count: number): ReadonlyArray<SubagentRunObservation> =>
  Array.from({ length: count }, (_, index) => {
    const run = worstRun(index);
    return run.state === "completed" || run.state === "failed"
      ? { run, completionReceipt: { id: run.id, generation: 1, claimToken: `claim-${run.id}` } }
      : { run };
  });

const resultText = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): string =>
  Arr.join(
    Arr.map(result.content, (part) => part.text ?? ""),
    "\n",
  );

/** Whole retained reports from 2 KiB up to the retained cap, each saved to its file. */
const wholeReportRuns = (count: number): ReadonlyArray<SubagentRunView> =>
  Array.from({ length: count }, (_, index) => {
    const finalText = longText(
      `WHOLE-${index}`,
      Math.min(MAX_FINAL_TEXT_CHARS, 2_048 * (count - index)),
    );
    return view({
      id: runIdFixture(index),
      name: longText(`worker-${index}`, MAX_NAME_CHARS),
      state: "completed",
      reportGeneration: 1,
      finalText,
      reportArchive: {
        path: maxPath(index),
        chars: finalText.length,
        lines: 1,
        complete: true,
      },
    });
  });

describe("worst-case model-facing output", () => {
  it("bounds every kind of run block", () => {
    for (const { run } of worstObservations(8))
      for (const delivered of [true, false])
        expect(
          formatRunBlock(runViewBlock(run, runViewOutcome(run, delivered))).length,
        ).toBeLessThanOrEqual(MAX_RUN_BLOCK_CHARS);
  });

  effectTest(
    "delivers every outcome of MAX_TARGET_RUNS worst-case runs in one await",
    function* () {
      const observations = worstObservations(MAX_TARGET_RUNS);
      const questions = Array.from({ length: 5 }, (_, index) => worstRun(1_000 + index * 4 + 3));
      const consumed: Array<string> = [];
      const tool = captureSubagentTools(
        subagentServiceDouble({
          withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
            use(observations, questions),
          consumeCompletions: (receipts) =>
            Effect.sync(() => {
              consumed.push(...Arr.map(receipts, (receipt) => receipt.id));
            }),
        }),
      ).get("agent_await")!;

      const result = yield* step(() =>
        executeTool(tool, {
          runIds: Arr.map(observations, ({ run }) => run.id),
          until: "all_finished",
        }),
      );

      const text = resultText(result);
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      const blocks = Str.split(text, RUN_BLOCK_SEPARATOR);
      for (const { run } of observations) {
        const block = Option.getOrElse(
          Arr.findFirst(blocks, (candidate) => Fn.pipe(candidate, Str.startsWith(`${run.id} `))),
          () => "",
        );
        if (run.reportArchive) expect(block).toContain(run.reportArchive.path);
        if (run.errorArchive) expect(block).toContain(run.errorArchive.path);
        // An outcome cut without a file points to agent_read for the rest.
        if (run.question || run.finalTextTruncation || (run.error && !run.errorArchive))
          expect(block).toContain("agent_read");
      }
      expect(consumed).toEqual(
        Arr.filterMap(observations, ({ run, completionReceipt }) =>
          completionReceipt ? Result.succeed(run.id) : Result.failVoid,
        ),
      );
      const contract = decodeSubagentContract("agent_await")(result.structuredContent);
      expect(JSON.stringify(contract).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      assert(contract !== undefined);
      expect(
        Arr.map(
          Arr.filter(contract.targets, (target) => target.state === "completed"),
          (target) => target.report.status,
        ),
      ).toEqual(
        Arr.map(
          Arr.filter(observations, ({ run }) => run.state === "completed"),
          () => "delivered",
        ),
      );
    },
  );

  effectTest(
    "bounds a lifecycle result for MAX_LIFECYCLE_TARGET_RUNS worst-case targets",
    function* () {
      const runs = Arr.map(worstObservations(MAX_LIFECYCLE_TARGET_RUNS), ({ run }) => run);
      const tool = captureSubagentTools(
        subagentServiceDouble({
          stop: (id) =>
            Fn.pipe(id, Str.endsWith("1"))
              ? Effect.fail(
                  InvalidSubagentRequestError.make({
                    code: "stop_failed",
                    message: longText("stop failed", MAX_ERROR_CHARS),
                  }),
                )
              : Effect.succeed(Option.getOrUndefined(Arr.findFirst(runs, (run) => run.id === id))!),
        }),
      ).get("agent_lifecycle")!;

      const result = yield* step(() =>
        executeTool(tool, { action: "stop", runIds: Arr.map(runs, (run) => run.id) }),
      );

      const text = resultText(result);
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      for (const run of runs) expect(text).toContain(run.id);
      const contract = decodeSubagentContract("agent_lifecycle")(result.structuredContent);
      expect(JSON.stringify(contract).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    },
  );

  effectTest("keeps a full await of large whole reports within the tool output", function* () {
    const runs = wholeReportRuns(MAX_TARGET_RUNS);
    const tool = captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use(
            Arr.map(runs, (run) => ({
              run,
              completionReceipt: { id: run.id, generation: 1, claimToken: `claim-${run.id}` },
            })),
          ),
        consumeCompletions: () => Effect.void,
      }),
    ).get("agent_await")!;

    const text = resultText(
      yield* step(() =>
        executeTool(tool, { runIds: Arr.map(runs, (run) => run.id), until: "all_finished" }),
      ),
    );

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    for (const run of runs) expect(text).toContain(run.reportArchive?.path);
    const inlined = Arr.filter(runs, (run) =>
      Fn.pipe(text, Str.includes(run.finalText ?? "missing")),
    );
    // The smallest report fits whole after the blocks; the largest can't.
    expect(Arr.map(inlined, (run) => run.id)).toContain(runs.at(-1)?.id);
    expect(Arr.map(inlined, (run) => run.id)).not.toContain(runs[0]?.id);
  });

  it("keeps a full batch of large whole reports within one notice", () => {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const runs = wholeReportRuns(MAX_COMPLETION_DELIVERY_BATCH);
    hostNotifier(extensionApiFixture({ sendMessage }))({
      type: "completed",
      runs: Arr.map(runs, (run) => ({
        id: run.id,
        name: run.name,
        generation: 1,
        outcome: "completed",
        finalText: run.finalText,
        reportArchive: run.reportArchive,
      })),
    });

    const content = sendMessage.mock.calls[0]?.[0].content;
    const text = Predicate.isString(content) ? content : "";
    expect(text.length).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
    for (const run of runs) expect(text).toContain(run.reportArchive?.path);
    expect(text).toContain(runs.at(-1)?.finalText);
  });

  it("names every run of a full worst-case completion batch in one notice", () => {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const runs: ReadonlyArray<SubagentCompletionNotification> = Array.from(
      { length: MAX_COMPLETION_DELIVERY_BATCH },
      (_, index) => {
        const run = worstRun(index % 4 === 3 ? index - 1 : index);
        return {
          id: runIdFixture(index),
          name: run.name,
          generation: 64,
          outcome: run.state === "failed" ? "failed" : "completed",
          finalText: run.finalText,
          finalTextTruncation: run.finalTextTruncation,
          reportArchive: run.reportArchive,
          error: run.error,
          errorArchive: run.errorArchive,
          warning: run.warning,
          profile: run.profile,
          nextCandidate: run.state === "failed" ? worstCandidate : undefined,
          workspaceId: run.workspaceId,
          workspaceOutcome: run.workspaceOutcome,
        };
      },
    );
    for (const run of runs)
      expect(formatRunBlock(completionBlock(run)).length).toBeLessThanOrEqual(MAX_RUN_BLOCK_CHARS);

    const delivery = hostNotifier(extensionApiFixture({ sendMessage }))({
      type: "completed",
      runs,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const content = sendMessage.mock.calls[0]?.[0].content;
    const text = Predicate.isString(content) ? content : "";
    expect(text.length).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
    for (const run of runs) {
      expect(text).toContain(`${run.id} `);
      if (run.reportArchive) expect(text).toContain(run.reportArchive.path);
    }
    expect(delivery?.deliveredCompletionKeys).toHaveLength(runs.length);
  });

  it("lists every launch of a full worst-case start batch", () => {
    const failures: ReadonlyArray<SubagentStartFailure> = Array.from(
      { length: MAX_START_BATCH },
      (_, index) => ({
        index,
        name: longText(`launch-${index}`, MAX_NAME_CHARS),
        code: "profile_no_eligible_model",
        message: longText(`START-FAILURE-${index}`, MAX_ERROR_CHARS),
        admittedRun: {
          runId: runIdFixture(index),
          cleanupDisposition: "quarantined",
          nextCandidate: worstCandidate,
          failureFile: archive(maxPath(index, "failure")),
          warning: longText(`WARNING-${index}`, MAX_ERROR_CHARS),
        },
      }),
    );

    const text = formatStartResult([], failures);

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    for (const failure of failures) {
      expect(text).toContain(`#${failure.index + 1} launch-`);
      expect(text).toContain(failure.admittedRun?.failureFile?.path);
    }
  });

  effectTest("agent_read returns the whole pending question an await previews", function* () {
    const run = worstRun(3);
    const question = run.question?.message ?? "missing";
    const tools = captureSubagentTools(
      subagentServiceDouble({
        agentRead: () =>
          Effect.succeed({
            agents: [
              {
                kind: "run",
                id: run.id,
                name: run.name,
                state: run.state,
                textStatus: "none",
                truncated: false,
                reportGeneration: 0,
                run,
              },
            ],
            missingIds: [],
          }),
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run }]),
      }),
    );

    const awaited = yield* step(() =>
      executeTool(tools.get("agent_await")!, { runIds: [run.id], until: "all_finished" }),
    );
    const read = yield* step(() => executeTool(tools.get("agent_read")!, { agentIds: [run.id] }));

    expect(resultText(awaited)).not.toContain(question);
    expect(resultText(read)).toContain(question);
    const [readout] = decodeSubagentContract("agent_read")(read.structuredContent)?.agents ?? [];
    expect(readout?.kind === "run" && readout.status.attention).toEqual({
      kind: "question",
      message: question,
    });
  });
});

/** Text at `length` characters whose end is a marker that only the whole text contains. */
const withTail = (tag: string, length: number): string => {
  const marker = `${tag}-END`;
  const body = `${Str.trimEnd(longText(tag, length - marker.length - 1))} `;
  return `${Fn.pipe(body, Str.padEnd(length - marker.length, "x"))}${marker}`;
};

/** A run with every read card field at its retained bound, in the given state. */
const worstReadRun = (
  state: "waiting" | "running" | "unsaved" | "saved" | "failed",
): SubagentRunView => {
  const base = worstRun(0);
  const common = {
    ...base,
    // The reader is main, the run's parent, so the card adds its next steps.
    parentRunId: undefined,
    cwd: `/${Fn.pipe("c", Str.repeat(4_000))}`,
    currentTool: longText("tool", 4_000),
    progress: longText("PROGRESS", MAX_CONTACT_TEXT_CHARS),
    childWarning: withTail("CHILD-WARNING", MAX_CONTACT_TEXT_CHARS),
    systemWarning: withTail("SYSTEM-WARNING", MAX_ERROR_CHARS),
    selection: { ...base.selection, warning: longText("route", 4_000) },
    finalText: undefined,
    reportArchive: undefined,
  };
  switch (state) {
    case "waiting":
      return view({
        ...common,
        state: "waiting_for_parent",
        question: { requestId: "q", message: withTail("QUESTION", MAX_CONTACT_TEXT_CHARS) },
      });
    case "running":
      return view({ ...common, state: "running" });
    case "unsaved":
      return view({
        ...common,
        state: "completed",
        reportGeneration: 1,
        finalText: withTail("REPORT", MAX_FINAL_TEXT_CHARS),
        finalTextTruncation: {
          retainedChars: MAX_FINAL_TEXT_CHARS,
          originalChars: Number.MAX_SAFE_INTEGER,
          originalLines: Number.MAX_SAFE_INTEGER,
        },
      });
    case "saved":
      return view({
        ...common,
        state: "completed",
        reportGeneration: 1,
        finalText: withTail("REPORT", MAX_FINAL_TEXT_CHARS),
        reportArchive: archive(maxPath(0)),
      });
    case "failed":
      return view({
        ...common,
        state: "failed",
        nextCandidate: worstCandidate,
        error: withTail("FAILURE", MAX_ERROR_CHARS),
      });
  }
  return Fn.absurd(state);
};

describe("multi-run agent_read", () => {
  effectTest("keeps every card of a full read and adds retained copies that fit", function* () {
    const runs = wholeReportRuns(MAX_TARGET_RUNS);
    const readouts = yield* Effect.forEach(runs, (run) =>
      runRecordFixture({ view: run }).pipe(Effect.map((record) => runReadout(record, run))),
    );
    const tool = captureSubagentTools(
      subagentServiceDouble({
        agentRead: () => Effect.succeed({ agents: readouts, missingIds: [] }),
      }),
    ).get("agent_read")!;

    const text = resultText(
      yield* step(() => executeTool(tool, { agentIds: Arr.map(runs, (run) => run.id) })),
    );

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    for (const run of runs) {
      expect(text).toContain(`${run.id} `);
      expect(text).toContain(run.reportArchive?.path);
    }
    expect(text).toContain(runs.at(-1)?.finalText);
  });
});

/** A question at its retained bound in `count` lines, the last ending with its marker. */
const questionOfLines = (count: number): string => {
  const width = Math.floor((MAX_CONTACT_TEXT_CHARS + 1) / count) - 1;
  return Arr.join(
    Array.from({ length: count }, (_, index) =>
      index === count - 1
        ? Fn.pipe("QUESTION-END", Str.padStart(width, "q"))
        : Fn.pipe("q", Str.repeat(width)),
    ),
    "\n",
  );
};

describe("worst-case single-run agent_read", () => {
  for (const state of ["waiting", "running", "unsaved", "saved", "failed"] as const)
    for (const verbose of [false, true])
      effectTest(
        `returns every recovery text of a ${state} run whole${verbose ? ", verbose" : ""}`,
        function* () {
          const run = worstReadRun(state);
          const record = yield* runRecordFixture({
            view: run,
            latestAssistantText: longText("ASSISTANT", MAX_FINAL_TEXT_CHARS),
          });
          const readout = runReadout(record, run);
          const tool = captureSubagentTools(
            subagentServiceDouble({
              agentRead: () => Effect.succeed({ agents: [readout], missingIds: [] }),
            }),
          ).get("agent_read")!;

          const result = yield* step(() => executeTool(tool, { agentIds: [run.id], verbose }));

          const text = resultText(result);
          expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
          const recovery = Arr.filter(
            [
              run.question?.message,
              // A saved report's retained copy follows its file, whole.
              run.finalText,
              run.reportArchive?.path,
              run.error,
              run.childWarning,
              run.systemWarning,
            ],
            Predicate.isNotUndefined,
          );
          for (const whole of recovery) expect(text).toContain(whole);

          const [read] =
            decodeSubagentContract("agent_read")(result.structuredContent)?.agents ?? [];
          const status = read?.kind === "run" ? read.status : undefined;
          assert(status !== undefined);
          expect(Arr.map(status.warnings, (warning) => warning.message)).toEqual([
            run.childWarning,
            run.systemWarning,
          ]);
          expect(status?.error).toBe(run.error);
          if (run.question)
            expect(status?.attention).toEqual({ kind: "question", message: run.question.message });
        },
      );

  // 512 lines take the whole indentation allowance; more lines fold into one.
  for (const count of [512, 8_187])
    effectTest(
      `fits a question of ${count} lines, none unindented, in a read and its notice`,
      function* () {
        const message = questionOfLines(count);
        expect(message.length).toBeLessThanOrEqual(MAX_CONTACT_TEXT_CHARS);
        const run = view({ ...worstReadRun("waiting"), question: { requestId: "q", message } });
        const record = yield* runRecordFixture({
          view: run,
          latestAssistantText: longText("ASSISTANT", MAX_FINAL_TEXT_CHARS),
        });
        const tool = captureSubagentTools(
          subagentServiceDouble({
            agentRead: () => Effect.succeed({ agents: [runReadout(record, run)], missingIds: [] }),
          }),
        ).get("agent_read")!;
        const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
        hostNotifier(extensionApiFixture({ sendMessage }))({
          type: "question",
          id: run.id,
          name: run.name,
          requestId: "q",
          message,
          generation: 1,
        });
        const content = sendMessage.mock.calls[0]?.[0].content;
        const notice = Predicate.isString(content) ? content : "";

        const text = resultText(yield* step(() => executeTool(tool, { agentIds: [run.id] })));

        expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
        expect(notice.length).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
        for (const [shown, indent] of [
          [text, "    "],
          [notice, "  "],
        ] as const) {
          const lines = Arr.filter(Str.split(shown, "\n"), (line) =>
            Fn.pipe(Str.trimStart(line), Str.startsWith("q")),
          );
          expect(Arr.every(lines, (line) => Fn.pipe(line, Str.startsWith(indent)))).toBe(true);
          expect(shown).toContain("QUESTION-END");
        }
        // A child's wire card keeps the whole question too.
        const card = agentReadCard(run, { caller: { kind: "main" } });
        expect(Option.getOrElse(Fn.pipe(card, Str.indexOf("QUESTION-END")), () => -1)).toBeLessThan(
          MAX_SUPERVISOR_AGENT_CARD_CHARS - "QUESTION-END\n… [status card truncated]".length,
        );
      },
    );
});

/** Text at `length` UTF-16 units that JSON escapes at up to six bytes each. */
const worstJsonText = (length: number): string =>
  Fn.pipe(`"\\\n${Fn.pipe("\uD800", Str.repeat(length))}`, Str.slice(0, length));

const jsonBytes = (value: SupervisorAgentReadResult | string): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("worst-case supervisor agent_read", () => {
  it("fits MAX_TARGET_RUNS reads in one channel line, MCP line, and CLI stdout line", () => {
    const result: SupervisorAgentReadResult = {
      agents: Array.from({ length: MAX_TARGET_RUNS }, (_, index) => ({
        id: Fn.pipe(
          `${runIdFixture(index)}-${Fn.pipe("x", Str.repeat(MAX_SUPERVISOR_MCP_AGENT_ID_CHARS))}`,
          Str.slice(0, MAX_SUPERVISOR_MCP_AGENT_ID_CHARS),
        ),
        name: worstJsonText(MAX_SUPERVISOR_AGENT_NAME_CHARS),
        state: "waiting_for_parent",
        card: worstJsonText(MAX_SUPERVISOR_AGENT_CARD_CHARS),
        text: worstJsonText(MAX_SUPERVISOR_AGENT_READ_CHARS),
        truncated: true,
        source: "assistant",
      })),
      missingIds: [],
    };
    // The result is at the schema's allowance: each text is as long as it admits.
    const success = SupervisorRpcGroup.requests.get("SupervisorAgentRead")?.successSchema;
    expect(success && Schema.decodeSync(success)(result)).toEqual(result);
    // Generous room for the RPC envelope, the MCP response, and the CLI's echo around the text.
    const envelope = 64 * 1024;
    expect(jsonBytes(result) + envelope).toBeLessThan(MAX_SUPERVISOR_CHANNEL_LINE_BYTES);
    const toolText = agentReadText(result);
    expect(jsonBytes(toolText) + envelope).toBeLessThan(MAX_SUPERVISOR_CHANNEL_LINE_BYTES);
    expect(jsonBytes(toolText) + envelope).toBeLessThan(MAX_PROCESS_LINE_BYTES);
  });
});

describe("unsaved report preview boundary", () => {
  const block = (length: number): string =>
    formatRunBlock(
      completionBlock({
        id: "agent-0000000001",
        name: "writer",
        generation: 1,
        outcome: "completed",
        finalText: withTail("REPORT", length),
      }),
    );

  it("shows a report of preview length whole, without a pointer", () => {
    const text = block(240);
    expect(text).toContain(withTail("REPORT", 240));
    expect(text).not.toContain("agent_read");
  });

  it("cuts a longer report and points to agent_read", () => {
    const text = block(241);
    expect(text).not.toContain("REPORT-END");
    expect(text).toContain("agent_read");
  });
});
