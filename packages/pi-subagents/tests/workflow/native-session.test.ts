// Actual Pi agent loop and native QuickJS, with an owned subagent backend boundary only.
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import { makeHostNotifier, type SubagentNotifier } from "../../src/boundary/host-notifier.ts";
import { registerWorkflowTool } from "../../src/tools/workflow.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { step } from "../support/effect-test.ts";
import {
  eventually,
  memoryLocations,
  profileLayerFor,
  reportTask,
  script,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

const claudeProfiles = profileLayerFor({
  version: 6,
  defaultProfileSet: "default",
  profileSets: {
    default: {
      profiles: { generalist: [declaredCandidate("claude-native", { runtime: "claude" })] },
    },
  },
});

/** A real Pi session whose model is scripted and whose subagents run on the native fake. */
const workflowSession = Effect.gen(function* () {
  let notifier: SubagentNotifier | undefined;
  let host: ExtensionAPI | undefined;
  const fixture = workflowFixture({ profiles: claudeProfiles, notify: (n) => notifier?.(n) });
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(Layer.merge(fixture.layer, fixture.backend.layer))),
    (managed) => step(() => managed.dispose()),
  );
  const { session, fake, ...base } = yield* fauxCodemodeSession({
    prefix: "subagents-dynamic-workflow-",
    provider: "dynamic-workflow-test",
    prompt: "Exercise the workflow",
    reply: "Continuing with other work.",
    extension: {
      name: "subagents-dynamic-workflow-test",
      factory: (cwd) => (pi) => {
        host = pi;
        notifier = makeHostNotifier(pi);
        registerWorkflowTool(pi, {
          environment: { cwd, projectTrusted: false },
          savedWorkflowLocations: memoryLocations,
          run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
        });
      },
    },
  });
  // Pi registers the runner inactive; the application activates it while workflows are on.
  const activateRunner = () =>
    host?.setActiveTools([...host.getActiveTools(), "subagent_workflow"]);
  const call = (name: string, args: JsonObject) =>
    base
      .call(name, args)
      .pipe(
        Effect.map(({ message }) =>
          message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        ),
      );
  return { session, fake, fixture, call, activateRunner };
});

// Live time is intentional: the script runs in a real QuickJS worker.
describe("dynamic workflows in a Pi session", () => {
  it.live("runs a script in the background and steers its result into the conversation", () =>
    Effect.gen(function* () {
      const { session, fake, fixture, call, activateRunner } = yield* workflowSession;
      expect(session.getActiveToolNames()).not.toContain("subagent_workflow");
      activateRunner();
      const scriptable = yield* call("codemode", {
        code: 'text(String("subagent_workflow" in tools));',
      });
      expect(scriptable).toContain("false");
      const started = yield* call("subagent_workflow", {
        action: "start",
        script: script('const found = await agent("Map the entry points"); return { found };'),
      });
      expect(started).toContain("runs in the background");
      // The result arrives later as one steering message that starts a new turn.
      fake.setResponses([fauxAssistantMessage("Read the workflow result.")]);
      yield* reportTask(fixture, "Map the entry points", "src/index.ts is the entry point.");
      const delivered = yield* eventually(
        () =>
          session.agent.state.messages.find(
            (message) =>
              message.role === "custom" && message.customType === "pi-subagents-workflow",
          ),
        "the workflow result in the conversation",
      );
      expect(delivered).toMatchObject({
        content: expect.stringContaining("src/index.ts is the entry point."),
      });
      yield* eventually(
        () => (session.isStreaming ? undefined : true),
        "the result turn to finish",
      );
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
});
