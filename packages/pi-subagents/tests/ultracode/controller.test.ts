// Host callbacks are Promise-shaped test boundaries.
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import { registerUltracodeController } from "../../src/application/ultracode.ts";
import { workflowAuthoringGuidePath } from "../../src/boundary/workflow-authoring-guide.ts";
import { effectTest, settle, step } from "../support/effect-test.ts";

const WORKFLOW = "subagent_workflow";
/** Tools other extensions own, which the controller must never remove. */
const OTHERS = ["read", "mcp__docs__search"];
/** The section of its own the controller writes its guidance to. */
const SECTION = "subagents_ultracode";

const controllerFixture = () => {
  let active: ReadonlyArray<string> = [...OTHERS];
  const userMessages: string[] = [];
  const { pi, emit } = recordingExtensionHost(
    {},
    {
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
      sendUserMessage: vi.fn((message: string) => {
        userMessages.push(message);
      }),
    },
  );
  const controller = registerUltracodeController(pi);
  const setStatus = vi.fn();
  let idle = true;
  const compaction = Deferred.makeUnsafe<void>();
  const ctx = extensionContextFixture({
    mode: "tui" as const,
    hasUI: true,
    isIdle: () => idle,
    waitForIdle: () => Effect.runPromise(Deferred.await(compaction)),
    ui: { setStatus, notify: vi.fn() },
  });
  /**
   * Starts an agent run from `prompt`, by default the latest request Pi was sent, and returns
   * the ultracode section of its system prompt. The custom prompt shows the section survives one.
   */
  const promptRun = function* (prompt = userMessages.at(-1) ?? "") {
    const sections: Record<string, string> = {};
    yield* settle(() =>
      emit("before_agent_start", ctx, {
        type: "before_agent_start",
        prompt,
        systemPromptOptions: {
          customPrompt: "A custom system prompt",
          promptGuidelines: [],
          sections,
        },
      }),
    );
    return sections[SECTION];
  };
  const settled = () => settle(() => emit("agent_settled", ctx, { type: "agent_settled" }));
  return {
    controller,
    ctx,
    pi,
    setStatus,
    userMessages,
    promptRun,
    settled,
    setIdle: (value: boolean) => {
      idle = value;
    },
    /** Pi finished compacting. */
    finishCompaction: () => {
      idle = true;
      Deferred.doneUnsafe(compaction, Effect.void);
    },
    agentStarted: () => settle(() => emit("agent_start", ctx, { type: "agent_start" })),
    workflowActive: () => active.includes(WORKFLOW),
    othersKept: () => OTHERS.every((name) => active.includes(name)),
    restore: (names: ReadonlyArray<string>) => {
      active = [...active, ...names];
    },
    /** Whether the footer shows a marker now. */
    marked: () => {
      const last = setStatus.mock.lastCall;
      return last !== undefined && last[1] !== undefined && String(last[1]).trim() !== "";
    },
  };
};

describe("ultracode tool activation", () => {
  effectTest(
    "keeps the workflow runner inactive and the prompt unchanged by default",
    function* () {
      const fixture = controllerFixture();
      fixture.controller.activate(fixture.ctx, false);
      expect(fixture.workflowActive()).toBe(false);
      expect(yield* fixture.promptRun()).toBeUndefined();
      expect(fixture.marked()).toBe(false);
    },
  );

  effectTest("follows the setting and marks the footer while it is on", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, true);
    expect(fixture.workflowActive()).toBe(true);
    expect(fixture.marked()).toBe(true);
    const guidance = yield* fixture.promptRun();
    expect(guidance).toContain(workflowAuthoringGuidePath());
    yield* fixture.settled();

    fixture.controller.setEnabled(false);
    expect(fixture.marked()).toBe(false);
    expect(fixture.workflowActive()).toBe(false);
    expect(yield* fixture.promptRun()).toBeUndefined();
    expect(fixture.othersKept()).toBe(true);
  });

  effectTest("sends a request and keeps the runner through the run that carries it", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    yield* step(() =>
      fixture.controller.send(fixture.ctx, { task: "review the parser", budget: 500_000 }),
    );
    expect(fixture.userMessages).toEqual([expect.stringContaining("review the parser")]);
    expect(fixture.workflowActive()).toBe(true);
    const oneOff = yield* fixture.promptRun();
    expect(oneOff).toContain(workflowAuthoringGuidePath());
    yield* fixture.settled();
    expect(fixture.workflowActive()).toBe(false);
    expect(fixture.othersKept()).toBe(true);

    // The standing guidance asks for more than the one-off note does.
    fixture.controller.setEnabled(true);
    const standing = yield* fixture.promptRun();
    expect(standing).toBeDefined();
    expect(standing).not.toBe(oneOff);
  });

  effectTest("forgets a request Pi never ran at the next prompt", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    yield* fixture.promptRun("an earlier prompt");
    yield* fixture.settled();
    // Pi swallowed the request's failure, for example because no model is selected.
    yield* step(() => fixture.controller.send(fixture.ctx, { task: "review the parser" }));
    expect(fixture.workflowActive()).toBe(true);
    expect(yield* fixture.promptRun("an unrelated prompt")).toBeUndefined();
    expect(fixture.workflowActive()).toBe(false);
  });

  effectTest("adds a request to the run under way as a follow-up", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    yield* fixture.promptRun("work on something");
    fixture.setIdle(false);
    yield* step(() => fixture.controller.send(fixture.ctx, { task: "review the parser" }));
    expect(fixture.pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "followUp",
    });
    expect(fixture.workflowActive()).toBe(true);
    yield* fixture.settled();
    expect(fixture.workflowActive()).toBe(false);
  });

  effectTest("waits for compaction to finish before sending a request", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    fixture.setIdle(false);
    const sending = fixture.controller.send(fixture.ctx, { task: "review the parser" });
    // Pi refuses prompts while it compacts, so nothing is sent or held yet.
    expect(fixture.userMessages).toEqual([]);
    expect(fixture.workflowActive()).toBe(false);
    fixture.finishCompaction();
    yield* step(() => sending);
    expect(fixture.userMessages).toHaveLength(1);
    expect(yield* fixture.promptRun()).toBeDefined();
  });

  effectTest("keeps the runner for a workflow run until its notification is handled", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    const observer = fixture.controller.observer();
    yield* step(() => fixture.controller.send(fixture.ctx, { task: "review the parser" }));
    yield* fixture.promptRun();
    observer.opened("wf-1");
    yield* fixture.settled();
    // The run is still live after the request's agent run settled.
    expect(fixture.workflowActive()).toBe(true);
    observer.closed("wf-1", "now");
    expect(fixture.workflowActive()).toBe(true);
    // A run that handles the notification without a prompt still settles the window.
    yield* fixture.agentStarted();
    expect(fixture.workflowActive()).toBe(true);
    yield* fixture.settled();
    expect(fixture.workflowActive()).toBe(false);
  });

  effectTest(
    "keeps the runner for the next run when a stopped run's notice waits mid-run",
    function* () {
      const fixture = controllerFixture();
      fixture.controller.activate(fixture.ctx, false);
      const observer = fixture.controller.observer();
      yield* step(() => fixture.controller.send(fixture.ctx, { task: "review the parser" }));
      yield* fixture.promptRun();
      observer.opened("wf-1");
      // The user stops the run in Activity while this agent run is still under way.
      observer.closed("wf-1", "next-turn");
      yield* fixture.settled();
      expect(fixture.workflowActive()).toBe(true);
      // The user's next prompt, asking to fix and resume, still has the runner and a note.
      expect(yield* fixture.promptRun("fix it and resume")).toBeDefined();
      yield* fixture.settled();
      expect(fixture.workflowActive()).toBe(false);
    },
  );

  it("ignores runs of an activation a session boundary replaced", () => {
    const fixture = controllerFixture();
    const stale = fixture.controller.observer();
    fixture.controller.reset();
    fixture.controller.activate(fixture.ctx, false);
    stale.opened("wf-old");
    expect(fixture.workflowActive()).toBe(false);
  });

  effectTest("leaves a runner Pi restored until the next agent run starts", function* () {
    const fixture = controllerFixture();
    // Pi restored the runner with tools still registering after a reload.
    fixture.restore([WORKFLOW, "mcp__late__tool"]);
    fixture.controller.activate(fixture.ctx, true);
    fixture.controller.setEnabled(false);
    // Removing a tool now would drop the rest of a loadout Pi is still restoring.
    expect(fixture.pi.setActiveTools).not.toHaveBeenCalled();
    expect(fixture.workflowActive()).toBe(true);
    yield* fixture.agentStarted();
    expect(fixture.workflowActive()).toBe(false);
    expect(fixture.othersKept()).toBe(true);
  });

  effectTest("changes no tools while the session's runtime is away", function* () {
    const fixture = controllerFixture();
    fixture.controller.activate(fixture.ctx, false);
    fixture.controller.suspend();
    fixture.controller.setEnabled(true);
    expect(fixture.workflowActive()).toBe(false);
    expect(yield* fixture.promptRun()).toBeUndefined();
  });
});
