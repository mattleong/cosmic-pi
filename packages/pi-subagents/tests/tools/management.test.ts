// Promise assertions are test-runner boundaries.
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, vi } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import { InvalidSubagentRequestError, SubagentNotFoundError } from "../../src/run/errors.ts";
import { type SubagentServiceContract } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  invokeOptionalTool,
  context,
  fallbackProfileService,
  startCapturingService,
  view,
} from "./fixtures/tool-harness.ts";

const resultText = (result: AgentToolResult<unknown>): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest(
    "returns formatted status metadata and one final report without activity duplication",
    function* () {
      const completed = view({
        state: "completed",
        endedAt: 2,
        profile: "reviewer",
        openaiFastMode: true,
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
        list: Effect.succeed([completed]),
        status: () => Effect.succeed(completed),
      });
      const tool = captureSubagentTools(service).get("subagent_status");

      const result = yield* invokeOptionalTool(tool, { runIds: ["agent-1"] });
      const text = result?.content[0]?.text ?? "";
      expect(text).toContain("pi_model_unknown");
      expect(text).not.toContain("Activity:");
      expect(text.match(/Viewport report\./g)).toHaveLength(1);
      expect(result?.details).toMatchObject({
        version: 2,
        action: "status",
        runCount: 1,
        cards: [
          {
            id: completed.id,
            name: completed.name,
            profile: completed.profile,
            host: completed.host,
            runtime: completed.runtime,
            model: completed.model,
            effort: completed.effort,
            openaiFastMode: completed.openaiFastMode,
            closeOnReport: completed.closeOnReport,
            reportGeneration: completed.reportGeneration,
            selection: {
              source: "profile-candidate",
              candidateIndex: 1,
              reason: completed.selection.reason,
              skippedCandidates: [{ code: "pi_model_unknown" }],
            },
            capabilities: completed.capabilities,
            finalText: "Viewport report.",
          },
        ],
      });

      const listed = yield* invokeOptionalTool(
        captureSubagentTools(service).get("subagent_list"),
        {},
      );
      expect(listed?.details).toMatchObject({
        version: 2,
        action: "list",
        runCount: 1,
        cards: [{ id: "agent-1" }],
      });
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const listDetails = listed?.details as
        | { cards?: ReadonlyArray<{ finalText?: string }> }
        | undefined;
      expect(listDetails?.cards?.[0]?.finalText).toBeUndefined();
    },
  );

  effectTest(
    "awaits a fleet in one live card and batches compact guidance acknowledgements",
    function* () {
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
      const descendant = view({
        id: "agent-child",
        name: "nested-review",
        parentRunId: "agent-1",
        depth: 2,
      });
      const sent: string[] = [];
      const service = subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, onUpdate, use) =>
          Effect.sync(() =>
            onUpdate?.(
              [view(), view({ id: "agent-2", name: "test-review" })],
              [view(), descendant, view({ id: "agent-2", name: "test-review" })],
            ),
          ).pipe(Effect.andThen(use([{ run: completedOne }, { run: completedTwo }]))),
        send: (id) => Effect.sync(() => (sent.push(id), id === "agent-1" ? view() : view({ id }))),
      });
      const tools = captureSubagentTools(service);
      const awaitTool = tools.get("subagent_await");
      const sendTool = tools.get("subagent_send");

      const updates: string[] = [];
      const awaited = yield* invokeOptionalTool(
        awaitTool,
        { runIds: [" agent-1 ", "agent-1", "agent-2"], until: "all_finished" },
        { update: (result) => updates.push(resultText(result)) },
      );
      expect(updates).toHaveLength(1);
      const progress = updates[0] ?? "";
      expect(progress).toContain("0/2");
      expect(progress).not.toContain("finished");
      expect(progress).toMatch(/◎ .*auth-review \(agent-1\)/);
      expect(progress.indexOf("auth-review")).toBeLessThan(progress.indexOf("nested-review"));
      expect(progress).toContain("test-review (agent-2)");
      expect(awaited?.content[0]?.text).toContain("First report.");
      expect(awaited?.content[0]?.text).toContain("Second report.");
      expect(awaited?.details).toMatchObject({
        action: "await",
        awaitedRunIds: ["agent-1", "agent-2"],
        cards: [
          { id: "agent-1" },
          { id: "agent-2" },
          { id: "agent-child", parentRunId: "agent-1" },
        ],
      });

      const sentResult = yield* invokeOptionalTool(sendTool, {
        runIds: ["agent-1", "agent-2"],
        message: "Conclude now.",
      });
      expect([...sent].sort()).toEqual(["agent-1", "agent-2"]);
      expect(sentResult?.content[0]?.text).toBe(
        "Guidance delivered to 2 subagents: agent-1, agent-2.",
      );
      expect(sentResult?.content[0]?.text).not.toContain("Subagent status");
    },
  );

  effectTest("publishes descendant-only usage changes in live await context", function* () {
    const target = view({ id: "agent-parent", parentRunId: "root", depth: 1 });
    const child = view({
      id: "agent-child",
      parentRunId: target.id,
      depth: 2,
    });
    const childWithUsage = view({
      ...child,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0 },
    });
    const completed = view({ ...target, state: "completed", endedAt: 2 });
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: (_ids, _until, onUpdate, use) =>
        Effect.sync(() => {
          onUpdate?.([target], [target, child]);
          onUpdate?.([target], [target, childWithUsage]);
        }).pipe(Effect.andThen(use([{ run: completed }]))),
    });
    const updates: AgentToolResult<unknown>[] = [];
    yield* invokeOptionalTool(
      captureSubagentTools(service).get("subagent_await"),
      { runIds: [target.id], until: "all_finished" },
      { update: (result) => updates.push(result) },
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]?.details).toMatchObject({
      action: "await",
      cards: [{ id: target.id }, { id: child.id, usage: { totalTokens: 12 } }],
    });
  });

  effectTest("handles tool-level await cancellation with retained attention", function* () {
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
    yield* step(() => Promise.resolve());
    yield* step(() => Promise.resolve());
    controller.abort();
    yield* step(() => expect(executing).rejects.toBeDefined());
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
    yield* step(() => expect(immediate).rejects.toBeDefined());
    expect(immediateUpdates.at(-1)).toContain("Await canceled before progress was observed");
  });

  effectTest("scopes persistent await presentation to tool execution", function* () {
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: () => Effect.never,
    });
    const release = vi.fn();
    const presentation = {
      beginStart: vi.fn(() => () => undefined),
      beginAwait: vi.fn(() => release),
      isLiveHierarchyAvailable: vi.fn(() => true),
    };
    const tools = captureSubagentTools(
      service,
      ["read"],
      fallbackProfileService,
      undefined,
      { cwd: "/project", projectTrusted: true },
      "high",
      undefined,
      presentation,
    );
    const controller = new AbortController();
    const executing = tools
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: ["agent-1"], until: "all_finished" },
        controller.signal,
        undefined,
        context,
      );

    yield* step(() => Promise.resolve());
    expect(presentation.beginAwait).toHaveBeenCalledWith(["agent-1"], "all_finished");
    expect(release).not.toHaveBeenCalled();
    controller.abort();
    yield* step(() => expect(executing).rejects.toBeDefined());
    expect(release).toHaveBeenCalledOnce();
  });

  effectTest(
    "reports per-target management outcomes without hiding successful side effects",
    function* () {
      const sent: string[] = [];
      const interrupted: string[] = [];
      const service = subagentServiceDouble({
        send: (id) =>
          id === "agent-2"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "not_running",
                  message: "agent-2 is paused",
                }),
              )
            : Effect.sync(() => (sent.push(id), view({ id }))),
        interrupt: (id) =>
          id === "agent-2"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "already_paused",
                  message: "agent-2 is already paused",
                }),
              )
            : Effect.sync(() => (interrupted.push(id), view({ id, state: "paused" }))),
      });
      const tools = captureSubagentTools(service);

      const sendResult = yield* invokeOptionalTool(tools.get("subagent_send"), {
        runIds: ["agent-1", "agent-2"],
        message: "Conclude.",
      });
      expect(sent).toEqual(["agent-1"]);
      expect(sendResult?.content[0]?.text).toContain("Guidance delivered to 1 subagent: agent-1.");
      expect(sendResult?.content[0]?.text).toContain("Failed targets (1)");
      expect(sendResult?.content[0]?.text).toContain("agent-2 [not_running]: agent-2 is paused");
      expect(sendResult?.details).toMatchObject({
        version: 2,
        action: "send",
        runCount: 1,
        actionFailures: [{ id: "agent-2", code: "not_running" }],
      });

      const lifecycleResult = yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
        action: "interrupt",
        runIds: ["agent-1", "agent-2"],
      });
      expect(interrupted).toEqual(["agent-1"]);
      expect(lifecycleResult?.content[0]?.text).toContain("Interrupted agent-1; state is paused.");
      expect(lifecycleResult?.content[0]?.text).toContain("agent-2 is already paused");
      expect(lifecycleResult?.details).toMatchObject({
        action: "interrupt",
        actionFailures: [{ id: "agent-2", code: "already_paused" }],
      });
    },
  );

  effectTest("rejects lifecycle messages for actions that cannot deliver them", function* () {
    const service = {
      ...startCapturingService([]),
      interrupt: () => Effect.succeed(view({ state: "paused" })),
    };
    const tool = captureSubagentTools(service).get("subagent_lifecycle");

    yield* step(() =>
      expect(
        tool?.execute(
          "call",
          { action: "interrupt", runIds: ["agent-1"], message: "Pause after this step." },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toThrow('message is valid only when action="resume"'),
    );
  });

  effectTest(
    "deduplicates repeated target IDs before applying management operations",
    function* () {
      const sent: string[] = [];
      const service = {
        ...startCapturingService([]),
        send: (id: string) => Effect.sync(() => (sent.push(id), view({ id }))),
      };
      const tool = captureSubagentTools(service).get("subagent_send");

      yield* invokeOptionalTool(tool, { runIds: ["agent-1", "agent-1"], message: "Conclude." });

      expect(sent).toEqual(["agent-1"]);
    },
  );

  effectTest(
    "acknowledges retained-send next assignments distinctly from steering guidance",
    function* () {
      const base = startCapturingService([]);
      const retainedView = (id: string) =>
        view({ id, closeOnReport: false, host: "herdr", state: "running", reportGeneration: 1 });
      const allRetained = subagentServiceDouble({
        ...base,
        send: (id) => Effect.succeed(retainedView(id)),
      });
      const retainedResult = yield* invokeOptionalTool(
        captureSubagentTools(allRetained).get("subagent_send"),
        { runIds: ["agent-r1", "agent-r2"], message: "Next task." },
      );
      expect(retainedResult?.content[0]?.text).toBe(
        "Started the next assignment on 2 retained subagents: agent-r1, agent-r2; subagent_await now targets the new report generation.",
      );

      const mixed = subagentServiceDouble({
        ...base,
        send: (id) => Effect.succeed(id === "agent-r1" ? retainedView(id) : view({ id })),
      });
      const mixedResult = yield* invokeOptionalTool(
        captureSubagentTools(mixed).get("subagent_send"),
        { runIds: ["agent-1", "agent-r1"], message: "Continue." },
      );
      const text = mixedResult?.content[0]?.text ?? "";
      expect(text).toContain("Guidance delivered to 1 subagent: agent-1.");
      expect(text).toContain(
        "Started the next assignment on 1 retained subagent: agent-r1; subagent_await now targets the new report generation.",
      );
    },
  );

  effectTest("renders state-aware stop acknowledgements for terminal no-ops", function* () {
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
    const result = yield* invokeOptionalTool(
      captureSubagentTools(service).get("subagent_lifecycle"),
      {
        action: "stop",
        runIds: ["agent-complete", "agent-failed", "agent-stopped"],
      },
    );
    expect(result?.content[0]?.text).toContain("agent-complete was already finished");
    expect(result?.content[0]?.text).toContain("agent-failed had already failed");
    expect(result?.content[0]?.text).toContain("agent-stopped is stopped.");
  });

  effectTest(
    "returns structured failures for single-target reply and rename operations",
    function* () {
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

      const replied = yield* invokeOptionalTool(tools.get("subagent_reply"), {
        runId: "agent-1",
        message: "Proceed.",
      });
      expect(replied?.content[0]?.text).toContain(
        "agent-1 [no_parent_question]: Subagent agent-1 has no pending parent question.",
      );
      expect(replied?.details).toMatchObject({
        actionFailures: [{ id: "agent-1", code: "no_parent_question" }],
      });

      const renamed = yield* invokeOptionalTool(tools.get("subagent_rename"), {
        runId: "agent-missing",
        name: "reviewer",
      });
      expect(renamed?.content[0]?.text).toContain(
        "agent-missing [SubagentNotFoundError]: Subagent run not found: agent-missing",
      );
    },
  );

  effectTest("routes focused reply, lifecycle, and rename operations", function* () {
    const operations: string[] = [];
    const service = subagentServiceDouble({
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
    });
    const tools = captureSubagentTools(service);

    yield* invokeOptionalTool(tools.get("subagent_reply"), {
      runId: "agent-1",
      message: "Proceed.",
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "interrupt",
      runIds: ["agent-1", "agent-2"],
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "resume",
      runIds: ["agent-1"],
      message: "Continue carefully.",
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "stop",
      runIds: ["agent-2"],
    });
    yield* invokeOptionalTool(tools.get("subagent_rename"), { runId: "agent-1", name: "reviewer" });

    expect(operations).toEqual([
      "reply:agent-1:Proceed.",
      "interrupt:agent-1",
      "interrupt:agent-2",
      "resume:agent-1:Continue carefully.",
      "stop:agent-2",
      "rename:agent-1:reviewer",
    ]);
  });

  effectTest("returns status for found IDs and model-visible failures for stale IDs", function* () {
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

    const result = yield* invokeOptionalTool(tool, { runIds: ["agent-1", "agent-stale"] });

    expect(result?.content[0]?.text).toContain("Final report\nDone.");
    expect(result?.content[0]?.text).toContain(
      "agent-stale [SubagentNotFoundError]: Subagent run not found: agent-stale",
    );
    expect(result?.details).toMatchObject({
      action: "status",
      actionFailures: [{ id: "agent-stale", code: "SubagentNotFoundError" }],
    });
  });

  effectTest("returns await immediately when a subagent needs a parent reply", function* () {
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

    const result = yield* invokeOptionalTool(tool, { runIds: ["agent-1"], until: "all_finished" });

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

  effectTest("returns ordered recovery for a contained paused writer", function* () {
    const paused = view({
      id: "agent-writer",
      name: "paused-writer",
      state: "paused",
      writeIntent: "writer",
      writeClaims: ["src/a.ts"],
      writeAdmissionPaused: true,
      writeViolationOffender: true,
      writeAudit: {
        observedFileWrites: ["src/b.ts"],
        violations: [{ path: "src/b.ts", toolName: "edit", observedAt: 2 }],
        bashWriteHints: 0,
      },
    });
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run: paused }]),
    });
    const tool = captureSubagentTools(service).get("subagent_await");

    const result = yield* invokeOptionalTool(tool, { runIds: [paused.id], until: "all_finished" });
    const text = result?.content[0]?.text ?? "";
    const review = text.indexOf("subagent_status");
    const grant = text.indexOf('subagent_claims({ action: "grant"');
    const admission = text.indexOf('subagent_claims({ action: "resume_admission"');
    const resume = text.indexOf('subagent_lifecycle({ action: "resume"');
    const awaitAgain = text.indexOf("subagent_await", resume);

    expect([review, grant, admission, resume, awaitAgain].every((index) => index >= 0)).toBe(true);
    expect(review).toBeLessThan(grant);
    expect(grant).toBeLessThan(admission);
    expect(admission).toBeLessThan(resume);
    expect(resume).toBeLessThan(awaitAgain);
    expect(text).not.toContain("subagent_reply");
    expect(result?.details).toMatchObject({
      action: "await",
      attentionRequired: true,
      cards: [
        {
          id: paused.id,
          state: "paused",
          writeAdmissionPaused: true,
          writeViolationOffender: true,
        },
      ],
    });
  });

  effectTest("branches after status while offender containment is still in progress", function* () {
    const transitioning = view({
      id: "agent-transitioning-writer",
      name: "transitioning-writer",
      state: "running",
      writeIntent: "writer",
      writeClaims: ["src/a.ts"],
      writeAdmissionPaused: true,
      writeViolationOffender: true,
      writeAudit: {
        observedFileWrites: ["src/b.ts"],
        violations: [{ path: "src/b.ts", toolName: "edit", observedAt: 2 }],
        bashWriteHints: 0,
      },
    });
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
        use([{ run: transitioning }]),
    });
    const result = yield* invokeOptionalTool(captureSubagentTools(service).get("subagent_await"), {
      runIds: [transitioning.id],
      until: "all_finished",
    });
    const text = result?.content[0]?.text ?? "";

    expect(text).toContain("Containment is in progress");
    expect(text).toContain("If status is paused");
    expect(text).toContain("If status is terminal");
    expect(text).not.toContain("Stop the offender and wait for cleanup");
    expect(result?.details).toMatchObject({ action: "await" });
    expect(result?.details).not.toMatchObject({ attentionRequired: true });
  });

  effectTest("does not recommend granting an outside-workspace violation", function* () {
    const stopped = view({
      id: "agent-outside",
      name: "outside-writer",
      state: "stopped",
      capabilities: ["interrupt"],
      writeIntent: "writer",
      writeClaims: ["src/a.ts"],
      writeAdmissionPaused: true,
      writeViolationOffender: true,
      writeAudit: {
        observedFileWrites: ["<outside workspace>"],
        violations: [{ path: "<outside workspace>", toolName: "edit", observedAt: 2 }],
        bashWriteHints: 0,
      },
    });
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run: stopped }]),
    });
    const tool = captureSubagentTools(service).get("subagent_await");

    const result = yield* invokeOptionalTool(tool, { runIds: [stopped.id], until: "all_finished" });
    const text = result?.content[0]?.text ?? "";
    const cleanup = text.indexOf("Confirm process and writer cleanup");
    const admission = text.indexOf('subagent_claims({ action: "resume_admission"');
    const replacement = text.indexOf("subagent_start");
    const awaitReplacement = text.indexOf("subagent_await", replacement);

    expect(text).toContain("<outside workspace>");
    expect(text).not.toContain('action: "grant"');
    expect([cleanup, admission, replacement, awaitReplacement].every((index) => index >= 0)).toBe(
      true,
    );
    expect(cleanup).toBeLessThan(admission);
    expect(admission).toBeLessThan(replacement);
    expect(replacement).toBeLessThan(awaitReplacement);
    expect(result?.details).toMatchObject({ action: "await", attentionRequired: true });
  });

  effectTest("does not treat a peer's historical audit as the current offender", function* () {
    const peer = view({
      id: "agent-repaired-peer",
      name: "repaired-peer",
      state: "running",
      writeIntent: "writer",
      writeClaims: ["src/a.ts", "src/old.ts"],
      writeAdmissionPaused: true,
      writeAudit: {
        observedFileWrites: ["src/old.ts"],
        violations: [{ path: "src/old.ts", toolName: "edit", observedAt: 1 }],
        bashWriteHints: 0,
      },
    });
    const service = subagentServiceDouble({
      ...startCapturingService([]),
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run: peer }]),
    });
    const result = yield* invokeOptionalTool(captureSubagentTools(service).get("subagent_await"), {
      runIds: [peer.id],
      until: "all_finished",
    });
    const text = result?.content[0]?.text ?? "";

    expect(text).toContain("Do not change this peer's claims");
    expect(text).not.toContain('action: "grant"');
    expect(text).not.toContain("Stop the offender and wait for cleanup");
    expect(result?.details).toMatchObject({ action: "await", attentionRequired: true });
  });

  effectTest(
    "enforces the combined target count and aggregate detailed-output budget",
    function* () {
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
      });
      const tool = captureSubagentTools(service).get("subagent_status");

      yield* step(() =>
        expect(
          tool?.execute(
            "call",
            {
              runIds: runs.map((run) => run.id),
            },
            undefined,
            undefined,
            context,
          ),
        ).rejects.toThrow("at most 12 targets"),
      );

      const result = yield* invokeOptionalTool(tool, {
        runIds: runs.slice(0, 12).map((run) => run.id),
      });
      const text = result?.content[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(48_000);
      for (const run of runs.slice(0, 12)) expect(text).toContain(run.id);
      expect(text).toContain("[run output truncated]");
      expect(consumed).toEqual([]);

      yield* invokeOptionalTool(tool, { runIds: ["agent-1"] });
      expect(consumed).toEqual([{ id: "agent-1", generation: 1, claimToken: "claim-agent-1" }]);
    },
  );

  effectTest("continues a failed run on the next frozen profile candidate", function* () {
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
          openaiFastMode: false,
          closeOnReport: true,
        },
        {
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          openaiFastMode: true,
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

    const result = yield* invokeOptionalTool(tool, { action: "retry", runIds: ["agent-1"] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      task: failed.task,
      profile: "reviewer",
      model: "openai-codex/gpt-5.6-sol",
      openaiFastMode: true,
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
      cards: [{ id: "agent-2" }],
    });
  });

  effectTest(
    "routes dedicated claim operations through the parent-only coordination tool",
    function* () {
      const grants: Array<{ readonly id: string; readonly paths: ReadonlyArray<string> }> = [];
      const claimed = view({
        id: "agent-claims",
        writeIntent: "writer",
        writeClaims: ["src/a.ts", "src/b.ts"],
        writeAdmissionPaused: true,
      });
      const service = subagentServiceDouble({
        ...startCapturingService([]),
        withStatusObservations: (_ids, use) =>
          use({ observations: [{ run: claimed }], missingIds: [] }),
        grantWriteClaims: (id, paths) =>
          Effect.sync(() => {
            grants.push({ id, paths });
            return claimed;
          }),
        resumeWriterAdmission: () =>
          Effect.succeed(
            view({
              ...claimed,
              state: "stopped",
              writeAdmissionPaused: undefined,
              writeViolationOffender: undefined,
              writeAudit: {
                observedFileWrites: ["src/b.ts"],
                violations: [{ path: "src/b.ts", toolName: "edit", observedAt: 2 }],
                bashWriteHints: 0,
              },
            }),
          ),
      });
      const tool = captureSubagentTools(service).get("subagent_claims");
      const result = yield* invokeOptionalTool(tool, {
        action: "grant",
        runId: "agent-claims",
        paths: ["src/b.ts"],
      });
      expect(grants).toEqual([{ id: "agent-claims", paths: ["src/b.ts"] }]);
      expect(result?.content[0]?.text).toContain("src/a.ts, src/b.ts");
      expect(result?.content[0]?.text).toContain("Do not use subagent_reply for containment");
      expect(result?.content[0]?.text).not.toContain("send the resulting authoritative claim set");
      expect(result?.details).toMatchObject({
        version: 2,
        action: "claims",
        cards: [{ id: "agent-claims", writeClaims: ["src/a.ts", "src/b.ts"] }],
      });

      const listed = yield* invokeOptionalTool(tool, { action: "list", runIds: ["agent-claims"] });
      expect(listed?.content[0]?.text).toContain("Do not use subagent_reply for containment");
      expect(listed?.content[0]?.text).not.toContain("send the resulting authoritative claim set");

      const reopened = yield* invokeOptionalTool(tool, {
        action: "resume_admission",
        runId: "agent-claims",
      });
      expect(reopened?.content[0]?.text).toContain("stop and replace");
      expect(reopened?.content[0]?.text).not.toContain(
        "send the resulting authoritative claim set",
      );
    },
  );

  effectTest(
    "enforces the final model-visible output bound for list, zero-run, and all-failure paths",
    function* () {
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
      const listed = yield* invokeOptionalTool(tools.get("subagent_list"), {});
      expect(listed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
      expect(listed?.content[0]?.text).toContain("tool output truncated; narrow the request");

      const emptyService = subagentServiceDouble({ ...base, list: Effect.succeed([]) });
      const empty = yield* invokeOptionalTool(
        captureSubagentTools(emptyService).get("subagent_list"),
        {},
      );
      expect(empty?.content[0]?.text).toBe("No subagent runs.");
      expect(empty?.content[0]?.text.length).toBeLessThanOrEqual(48_000);

      const failed = yield* invokeOptionalTool(tools.get("subagent_start"), {
        agents: Array.from({ length: 12 }, (_, index) => ({
          task: `Fail ${index + 1}`,
        })),
      });
      expect(failed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
      expect(failed?.content[0]?.text).toContain("Failed starts (12)");
    },
  );
});
