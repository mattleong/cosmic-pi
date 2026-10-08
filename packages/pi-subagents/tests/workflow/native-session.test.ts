// Actual Pi agent loop and native QuickJS, with an owned subagent backend boundary only.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { workflowSession } from "./fixtures/native-workflow-session.ts";
import { eventually, reportTask, script } from "./fixtures/workflow-harness.ts";

// Live time is intentional: the script runs in a real QuickJS worker.
describe("dynamic workflows in a Pi session", () => {
  it.live("runs a script in the background and steers its result into the conversation", () =>
    Effect.gen(function* () {
      const { session, fake, fixture, call, controller } = yield* workflowSession({
        enabled: false,
        notifyConversation: true,
      });
      expect(session.getActiveToolNames()).not.toContain("subagent_workflow");
      controller.setEnabled(true);
      const scriptable = yield* call("codemode", {
        code: 'text(String("subagent_workflow" in tools));',
      });
      expect(scriptable.text).toContain("true");
      const started = yield* call("subagent_workflow", {
        action: "start",
        script: script('const found = await agent("Map the entry points"); return { found };'),
      });
      expect(started.isError).toBe(false);
      expect(started.text).toContain("runs in the background");
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
      expect(
        session.agent.state.messages.filter(
          (message) => message.role === "custom" && message.customType === "pi-subagents-workflow",
        ),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
});
