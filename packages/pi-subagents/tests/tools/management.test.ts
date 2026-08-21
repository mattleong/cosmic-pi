// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import { InvalidSubagentRequestError, SubagentNotFoundError } from "../../src/run/errors.ts";
import { type SubagentServiceContract } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  context,
  startCapturingService,
  view,
} from "./fixtures/tool-harness.ts";

const resultText = (result: AgentToolResult<unknown>): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("returns formatted status metadata and one final report without activity duplication", async () => {
    const completed = view({
      state: "completed",
      endedAt: 2,
      profile: "reviewer",
      fastMode: true,
      selection: {
        source: "profile-candidate",
        candidateIndex: 1,
        reason: "Profile reviewer selected configured candidate 2.",
        skippedCandidates: [
          {
            candidateIndex: 0,
            candidate: "pi/old-model",
            code: "pi_model_unknown",
            reason: "Pi candidate is unknown or unauthenticated.",
          },
        ],
      },
      finalText: "Viewport report.",
      sessionEvents: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "read",
          target: "README.md",
          state: "completed",
          startedAt: 1,
          endedAt: 2,
        },
        { type: "assistant", text: "Viewport report.", createdAt: 2 },
      ],
    });
    const service = subagentServiceDouble({
      start: () => Effect.succeed(completed),
      awaitTerminal: () => Effect.succeed([completed]),
      list: Effect.succeed([completed]),
      status: () => Effect.succeed(completed),
      send: () => Effect.succeed(completed),
      reply: () => Effect.succeed(completed),
      interrupt: () => Effect.succeed(completed),
      resume: () => Effect.succeed(completed),
      rename: () => Effect.succeed(completed),
      stop: () => Effect.succeed(completed),
      projection: Effect.succeed({ revision: 1, runs: [completed] }),
    });
    const tool = captureSubagentTools(service).get("subagent_status");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1"] },
      undefined,
      undefined,
      context,
    );
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain("Subagent status");
    expect(text).toContain("Name       auth-review");
    expect(text).toContain("ID         agent-1");
    expect(text).toContain("Profile    reviewer");
    expect(text).toContain("Route      local/pi · openai-codex/gpt-5.6-sol:high ⚡");
    expect(text).toContain("Retention  close after report · assignment 1");
    expect(text).toContain("Selection  profile-candidate candidate 2");
    expect(text).toContain("Reason     Profile reviewer selected configured candidate 2.");
    expect(text).toContain("Skipped    candidate 1 [pi_model_unknown]");
    expect(text).toContain(
      "Capabilities steer, interrupt, resume, rename-display, parent-contact, peer-notice, native-fork",
    );
    expect(text).toContain("Final report\nViewport report.");
    expect(text).not.toContain("Activity:");
    expect(text.match(/Viewport report\./g)).toHaveLength(1);
    expect(result?.details).toMatchObject({
      version: 1,
      action: "status",
      runIds: ["agent-1"],
      runCount: 1,
      cards: [{ id: "agent-1", finalText: "Viewport report." }],
    });

    const listed = await captureSubagentTools(service)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(listed?.details).toMatchObject({
      version: 1,
      action: "list",
      runIds: ["agent-1"],
      runCount: 1,
      cards: [{ id: "agent-1" }],
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const listDetails = listed?.details as
      | { cards?: ReadonlyArray<{ finalText?: string }> }
      | undefined;
    expect(listDetails?.cards?.[0]?.finalText).toBeUndefined();
  });

  it("awaits a fleet in one live card and batches compact guidance acknowledgements", async () => {
    const completedOne = view({
      id: "agent-1",
      state: "completed",
      endedAt: 2,
      finalText: "First report.",
    });
    const completedTwo = view({
      id: "agent-2",
      name: "test-review",
      state: "completed",
      endedAt: 2,
      finalText: "Second report.",
    });
    const sent: string[] = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(view()),
      awaitTerminal: (_ids, _until, onUpdate) =>
        Effect.sync(() => {
          onUpdate?.([view(), view({ id: "agent-2", name: "test-review" })]);
          return [completedOne, completedTwo];
        }),
      list: Effect.succeed([]),
      status: (id) => Effect.succeed(id === "agent-1" ? completedOne : completedTwo),
      send: (id) => Effect.sync(() => (sent.push(id), id === "agent-1" ? view() : view({ id }))),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tools = captureSubagentTools(service);
    const awaitTool = tools.get("subagent_await");
    const sendTool = tools.get("subagent_send");

    const updates: string[] = [];
    const awaited = await awaitTool?.execute(
      "call",
      { runIds: ["agent-1", "agent-2"], until: "all_finished" },
      undefined,
      (result) => updates.push(resultText(result)),
      context,
    );
    expect(updates).toEqual([
      "Waiting for all subagents · 0 of 2 subagents finished · 2 running\n⠋ auth-review (agent-1) · running\n⠋ test-review (agent-2) · running",
    ]);
    expect(awaited?.content[0]?.text).toContain("First report.");
    expect(awaited?.content[0]?.text).toContain("Second report.");
    expect(awaited?.details).toMatchObject({
      action: "await",
      cards: [{ id: "agent-1" }, { id: "agent-2" }],
    });

    const sentResult = await sendTool?.execute(
      "call",
      { runIds: ["agent-1", "agent-2"], message: "Conclude now." },
      undefined,
      undefined,
      context,
    );
    expect([...sent].sort()).toEqual(["agent-1", "agent-2"]);
    expect(sentResult?.content[0]?.text).toBe(
      "Guidance delivered to 2 subagents: agent-1, agent-2.",
    );
    expect(sentResult?.content[0]?.text).not.toContain("Subagent status");
  });

  it("handles tool-level await cancellation with retained attention", async () => {
    const base = startCapturingService([]);
    const noProgressService = subagentServiceDouble({
      ...base,
      withAwaitTerminalObservations: () => Effect.never,
    });
    const waiting = view({
      id: "agent-question",
      state: "waiting_for_parent",
      question: { requestId: "question", message: "Which fixture?", createdAt: 2 },
    });
    const cancelService = subagentServiceDouble({
      ...base,
      withAwaitTerminalObservations: (_ids, _until, onUpdate) =>
        Effect.sync(() => onUpdate?.([waiting])).pipe(Effect.andThen(Effect.never)),
    });
    const updates: string[] = [];
    const controller = new AbortController();
    const executing = captureSubagentTools(cancelService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [waiting.id], until: "all_finished" },
        controller.signal,
        (result) => updates.push(resultText(result)),
        context,
      );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(executing).rejects.toBeDefined();
    const cancelled = updates.at(-1) ?? "";
    expect(cancelled).toContain("Await canceled; 1 subagent is unfinished.");
    expect(cancelled).toContain("Question from auth-review: Which fixture?");
    expect(cancelled).toContain('subagent_reply({ runId: "agent-question", message: "..." })');

    const immediateUpdates: string[] = [];
    const immediateController = new AbortController();
    immediateController.abort();
    const immediate = captureSubagentTools(noProgressService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [waiting.id], until: "all_finished" },
        immediateController.signal,
        (result) => immediateUpdates.push(resultText(result)),
        context,
      );
    await expect(immediate).rejects.toBeDefined();
    expect(immediateUpdates.at(-1)).toContain("Await canceled before progress was observed");
  });

  it("reports per-target management outcomes without hiding successful side effects", async () => {
    const sent: string[] = [];
    const interrupted: string[] = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: (id) =>
        id === "agent-2"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "not_running",
                message: "agent-2 is paused",
              }),
            )
          : Effect.sync(() => (sent.push(id), view({ id }))),
      reply: () => Effect.succeed(view()),
      interrupt: (id) =>
        id === "agent-2"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "already_paused",
                message: "agent-2 is already paused",
              }),
            )
          : Effect.sync(() => (interrupted.push(id), view({ id, state: "paused" }))),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tools = captureSubagentTools(service);

    const sendResult = await tools
      .get("subagent_send")
      ?.execute(
        "call",
        { runIds: ["agent-1", "agent-2"], message: "Conclude." },
        undefined,
        undefined,
        context,
      );
    expect(sent).toEqual(["agent-1"]);
    expect(sendResult?.content[0]?.text).toContain("Guidance delivered to 1 subagent: agent-1.");
    expect(sendResult?.content[0]?.text).toContain("Failed targets (1)");
    expect(sendResult?.content[0]?.text).toContain("agent-2 [not_running]: agent-2 is paused");
    expect(sendResult?.details).toMatchObject({
      version: 1,
      action: "send",
      runIds: ["agent-1"],
      actionFailures: [{ id: "agent-2", code: "not_running" }],
    });

    const lifecycleResult = await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1", "agent-2"] },
        undefined,
        undefined,
        context,
      );
    expect(interrupted).toEqual(["agent-1"]);
    expect(lifecycleResult?.content[0]?.text).toContain("Interrupted agent-1; state is paused.");
    expect(lifecycleResult?.content[0]?.text).toContain("agent-2 is already paused");
    expect(lifecycleResult?.details).toMatchObject({
      action: "interrupt",
      actionFailures: [{ id: "agent-2", code: "already_paused" }],
    });
  });

  it("rejects lifecycle messages for actions that cannot deliver them", async () => {
    const service = {
      ...startCapturingService([]),
      interrupt: () => Effect.succeed(view({ state: "paused" })),
    };
    const tool = captureSubagentTools(service).get("subagent_lifecycle");

    await expect(
      tool?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1"], message: "Pause after this step." },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow('message is valid only when action="resume"');
  });

  it("deduplicates repeated target IDs before applying management operations", async () => {
    const sent: string[] = [];
    const service = {
      ...startCapturingService([]),
      send: (id: string) => Effect.sync(() => (sent.push(id), view({ id }))),
    };
    const tool = captureSubagentTools(service).get("subagent_send");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1", "agent-1"], message: "Conclude." },
      undefined,
      undefined,
      context,
    );

    expect(sent).toEqual(["agent-1"]);
    expect(result?.content[0]?.text).toBe("Guidance delivered to 1 subagent: agent-1.");
  });

  it("acknowledges retained-send next assignments distinctly from steering guidance", async () => {
    const base = startCapturingService([]);
    const retainedView = (id: string) =>
      view({ id, closeOnReport: false, host: "herdr", state: "running", reportGeneration: 1 });
    const allRetained = subagentServiceDouble({
      ...base,
      send: (id) => Effect.succeed(retainedView(id)),
    });
    const retainedResult = await captureSubagentTools(allRetained)
      .get("subagent_send")
      ?.execute(
        "call",
        { runIds: ["agent-r1", "agent-r2"], message: "Next task." },
        undefined,
        undefined,
        context,
      );
    expect(retainedResult?.content[0]?.text).toBe(
      "Started the next assignment on 2 retained subagents: agent-r1, agent-r2; subagent_await now targets the new report generation.",
    );

    const mixed = subagentServiceDouble({
      ...base,
      send: (id) => Effect.succeed(id === "agent-r1" ? retainedView(id) : view({ id })),
    });
    const mixedResult = await captureSubagentTools(mixed)
      .get("subagent_send")
      ?.execute(
        "call",
        { runIds: ["agent-1", "agent-r1"], message: "Continue." },
        undefined,
        undefined,
        context,
      );
    const text = mixedResult?.content[0]?.text ?? "";
    expect(text).toContain("Guidance delivered to 1 subagent: agent-1.");
    expect(text).toContain(
      "Started the next assignment on 1 retained subagent: agent-r1; subagent_await now targets the new report generation.",
    );
  });

  it("renders state-aware stop acknowledgements for terminal no-ops", async () => {
    const base = startCapturingService([]);
    const service = subagentServiceDouble({
      ...base,
      stop: (id) =>
        Effect.succeed(
          view({
            id,
            state:
              id === "agent-complete" ? "completed" : id === "agent-failed" ? "failed" : "stopped",
          }),
        ),
    });
    const result = await captureSubagentTools(service)
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        {
          action: "stop",
          runIds: ["agent-complete", "agent-failed", "agent-stopped"],
        },
        undefined,
        undefined,
        context,
      );
    expect(result?.content[0]?.text).toContain("agent-complete was already finished");
    expect(result?.content[0]?.text).toContain("agent-failed had already failed");
    expect(result?.content[0]?.text).toContain("agent-stopped is stopped.");
  });

  it("returns structured failures for single-target reply and rename operations", async () => {
    const service = {
      ...startCapturingService([]),
      reply: (id: string) =>
        Effect.fail(
          new InvalidSubagentRequestError({
            code: "no_parent_question",
            message: `Subagent ${id} has no pending parent question.`,
          }),
        ),
      rename: (id: string) =>
        Effect.fail(new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` })),
    };
    const tools = captureSubagentTools(service);

    const replied = await tools
      .get("subagent_reply")
      ?.execute("call", { runId: "agent-1", message: "Proceed." }, undefined, undefined, context);
    expect(replied?.content[0]?.text).toContain(
      "agent-1 [no_parent_question]: Subagent agent-1 has no pending parent question.",
    );
    expect(replied?.details).toMatchObject({
      actionFailures: [{ id: "agent-1", code: "no_parent_question" }],
    });

    const renamed = await tools
      .get("subagent_rename")
      ?.execute(
        "call",
        { runId: "agent-missing", name: "reviewer" },
        undefined,
        undefined,
        context,
      );
    expect(renamed?.content[0]?.text).toContain(
      "agent-missing [SubagentNotFoundError]: Subagent run not found: agent-missing",
    );
  });

  it("routes focused reply, lifecycle, and rename operations", async () => {
    const operations: string[] = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: (id, message) =>
        Effect.sync(() => (operations.push(`reply:${id}:${message}`), view({ id }))),
      interrupt: (id) =>
        Effect.sync(() => (operations.push(`interrupt:${id}`), view({ id, state: "paused" }))),
      resume: (id, message) =>
        Effect.sync(() => (operations.push(`resume:${id}:${message ?? ""}`), view({ id }))),
      rename: (id, name) =>
        Effect.sync(() => (operations.push(`rename:${id}:${name}`), view({ id, name }))),
      stop: (id) =>
        Effect.sync(() => (operations.push(`stop:${id}`), view({ id, state: "stopped" }))),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tools = captureSubagentTools(service);

    await tools
      .get("subagent_reply")
      ?.execute("call", { runId: "agent-1", message: "Proceed." }, undefined, undefined, context);
    await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1", "agent-2"] },
        undefined,
        undefined,
        context,
      );
    await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "resume", runIds: ["agent-1"], message: "Continue carefully." },
        undefined,
        undefined,
        context,
      );
    await tools
      .get("subagent_lifecycle")
      ?.execute("call", { action: "stop", runIds: ["agent-2"] }, undefined, undefined, context);
    await tools
      .get("subagent_rename")
      ?.execute("call", { runId: "agent-1", name: "reviewer" }, undefined, undefined, context);

    expect(operations).toEqual([
      "reply:agent-1:Proceed.",
      "interrupt:agent-1",
      "interrupt:agent-2",
      "resume:agent-1:Continue carefully.",
      "stop:agent-2",
      "rename:agent-1:reviewer",
    ]);
  });

  it("returns status for found IDs and model-visible failures for stale IDs", async () => {
    const completed = view({ state: "completed", finalText: "Done." });
    const withStatusObservations: SubagentServiceContract["withStatusObservations"] = (ids, use) =>
      use({
        observations: ids.includes("agent-1") ? [{ run: completed }] : [],
        missingIds: ids.filter((id) => id !== "agent-1"),
      });
    const service = {
      ...startCapturingService([]),
      withStatusObservations,
    };
    const tool = captureSubagentTools(service).get("subagent_status");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1", "agent-stale"] },
      undefined,
      undefined,
      context,
    );

    expect(result?.content[0]?.text).toContain("Final report\nDone.");
    expect(result?.content[0]?.text).toContain(
      "agent-stale [SubagentNotFoundError]: Subagent run not found: agent-stale",
    );
    expect(result?.details).toMatchObject({
      action: "status",
      actionFailures: [{ id: "agent-stale", code: "SubagentNotFoundError" }],
    });
  });

  it("returns await immediately when a subagent needs a parent reply", async () => {
    const waiting = view({
      state: "waiting_for_parent",
      question: {
        requestId: "question-1",
        message: "Should I update the fixture?",
        createdAt: 2,
      },
    });
    const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] =
      (_ids, _until, _onUpdate, use) => use([{ run: waiting }]);
    const service = {
      ...startCapturingService([]),
      withAwaitTerminalObservations,
    };
    const tool = captureSubagentTools(service).get("subagent_await");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1"], until: "all_finished" },
      undefined,
      undefined,
      context,
    );

    expect(result?.content[0]?.text).toContain(
      'Reply with subagent_reply({ runId: "agent-1", message: "..." }), then call subagent_await again.',
    );
    expect(result?.content[0]?.text).toContain("Needs reply Should I update the fixture?");
    expect(result?.details).toMatchObject({
      action: "await",
      attentionRequired: true,
      cards: [{ state: "waiting_for_parent" }],
    });
  });

  it("enforces the combined target count and aggregate detailed-output budget", async () => {
    const runs = Array.from({ length: 13 }, (_, index) =>
      view({
        id: `agent-${index + 1}`,
        name: `review-${index + 1}`,
        state: "completed",
        finalText: "x".repeat(32 * 1024),
      }),
    );
    const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(runs[0]!),
      awaitTerminal: (ids) => Effect.succeed(ids.map((id) => runs.find((run) => run.id === id)!)),
      list: Effect.succeed(runs),
      status: (id) => Effect.succeed(runs.find((run) => run.id === id)!),
      observeStatus: (id) =>
        Effect.succeed({
          run: runs.find((run) => run.id === id)!,
          completionReceipt: { id, generation: 1, claimToken: `claim-${id}` },
        }),
      consumeCompletions: (receipts) =>
        Effect.sync(() => {
          consumed.push(...receipts);
        }),
      send: () => Effect.succeed(runs[0]!),
      reply: () => Effect.succeed(runs[0]!),
      interrupt: () => Effect.succeed(runs[0]!),
      resume: () => Effect.succeed(runs[0]!),
      rename: () => Effect.succeed(runs[0]!),
      stop: () => Effect.succeed(runs[0]!),
      projection: Effect.succeed({ revision: 0, runs }),
    });
    const tool = captureSubagentTools(service).get("subagent_status");

    await expect(
      tool?.execute(
        "call",
        {
          runIds: runs.map((run) => run.id),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("at most 12 targets");

    const result = await tool?.execute(
      "call",
      { runIds: runs.slice(0, 12).map((run) => run.id) },
      undefined,
      undefined,
      context,
    );
    const text = result?.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(48_000);
    for (const run of runs.slice(0, 12)) expect(text).toContain(run.id);
    expect(text).toContain("[run output truncated]");
    expect(consumed).toEqual([]);

    await tool?.execute("call", { runIds: ["agent-1"] }, undefined, undefined, context);
    expect(consumed).toEqual([{ id: "agent-1", generation: 1, claimToken: "claim-agent-1" }]);
  });

  it("continues a failed run on the next frozen profile candidate", async () => {
    const failed = view({
      id: "agent-1",
      state: "failed",
      profile: "reviewer",
      error: "Claude usage exhausted.",
      remainingCandidateCount: 1,
      selection: {
        source: "profile-candidate",
        routeSource: "global",
        host: "local",
        runtime: "claude",
        closeOnReport: true,
        candidateIndex: 0,
        reason: "Profile reviewer selected candidate 1.",
        skippedCandidates: [],
      },
    });
    const route = {
      profile: "reviewer",
      routeSource: "global",
      candidates: [
        {
          host: "local",
          runtime: "claude",
          model: "claude-fable-5",
          effort: "medium",
          context: "fresh",
          writeIntent: "read-only",
          fastMode: false,
          closeOnReport: true,
        },
        {
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          fastMode: true,
          closeOnReport: true,
        },
      ],
      selectedCandidateIndex: 0,
      skippedCandidates: [],
    } satisfies ProfileRouteContinuation;
    const requests: Array<Parameters<SubagentServiceContract["startRetrySessionOwned"]>[0]> = [];
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      claimRetryContinuation: () =>
        Effect.succeed({ source: failed, continuation: route, claimToken: "retry-1" }),
      startRetrySessionOwned: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return view({
            id: "agent-2",
            name: request.name ?? failed.name,
            task: request.task,
            profile: request.profile ?? "reviewer",
            predecessorRunId: request.supersedes.runId,
            selection: request.selection ?? failed.selection,
          });
        }),
    });
    const tool = captureSubagentTools(service).get("subagent_lifecycle");

    const result = await tool?.execute(
      "call",
      { action: "retry", runIds: ["agent-1"] },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      task: failed.task,
      profile: "reviewer",
      model: "openai-codex/gpt-5.6-sol",
      fastMode: true,
      supersedes: { runId: "agent-1", claimToken: "retry-1" },
      routeContinuation: { selectedCandidateIndex: 1 },
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "previous_run_failed" }],
      },
    });
    expect(result?.content[0]?.text).toContain(
      "Continued agent-1 as agent-2 on profile reviewer candidate 2.",
    );
    expect(result?.details).toMatchObject({
      action: "retry",
      cards: [{ id: "agent-2", predecessorRunId: "agent-1" }],
    });
  });

  it("enforces the final model-visible output bound for list, zero-run, and all-failure paths", async () => {
    const oversizedRuns = Array.from({ length: 12 }, (_, index) =>
      view({
        id: `agent-${index + 1}`,
        name: `run-${index + 1}`,
        model: `provider/${"m".repeat(8_000)}`,
      }),
    );
    const base = startCapturingService([]);
    const failStart: SubagentServiceContract["start"] = () =>
      Effect.fail(
        new InvalidSubagentRequestError({
          code: "all_failed",
          message: "f".repeat(64_000),
        }),
      );
    const service = subagentServiceDouble({
      ...base,
      list: Effect.succeed(oversizedRuns),
      start: failStart,
      startSessionOwned: failStart,
    });
    const tools = captureSubagentTools(service);
    const listed = await tools
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(listed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(listed?.content[0]?.text).toContain("tool output truncated; narrow the request");

    const emptyService = subagentServiceDouble({ ...base, list: Effect.succeed([]) });
    const empty = await captureSubagentTools(emptyService)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(empty?.content[0]?.text).toBe("No subagent runs.");
    expect(empty?.content[0]?.text.length).toBeLessThanOrEqual(48_000);

    const failed = await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: Array.from({ length: 12 }, (_, index) => ({
          task: `Fail ${index + 1}`,
        })),
      },
      undefined,
      undefined,
      context,
    );
    expect(failed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(failed?.content[0]?.text).toContain("Failed starts (12)");
  });
});
