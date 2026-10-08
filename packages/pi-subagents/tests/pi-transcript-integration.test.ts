import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { describe, expect, it } from "@effect/vitest";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import {
  fauxModels,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "pi-cosmic-core/testing/sdk";
import { childToolPolicy, createForkedSession } from "../src/boundary/child-process.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";

describe("installed Pi transcript reconstruction", () => {
  it.live(
    "uses child prompt/tools and restores executable membership when navigating branches",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("pi-transcript-");
        const { fake, models } = yield* fauxModels("subagent-transcript-test");
        const parent = SessionManager.create(directory, directory);
        parent.appendMessage({
          role: "system",
          content: "parent-only opaque instruction",
          toolsAdded: [{ name: "parent_only", description: "parent", parameters: Type.Object({}) }],
          timestamp: 1,
        });
        parent.appendMessage({ role: "user", content: "parent conversation", timestamp: 2 });
        parent.appendMessage(fauxAssistantMessage("parent answer"));
        const forkFile = yield* createForkedSession(
          backendLaunch({
            cwd: directory,
            context: "fork",
            parentSessionId: parent.getSessionId(),
            parentSessionFile: parent.getSessionFile()!,
            parentLeafId: parent.getLeafId()!,
          }),
          directory,
        );
        const settings = quietSettings();
        const executed: string[] = [];
        const loader = yield* quietLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          noExtensions: true,
          systemPromptOverride: () => "child-only instruction",
          extensionFactories: [
            (pi) => {
              for (const name of ["child_alpha", "child_beta"])
                pi.registerTool({
                  name,
                  label: name,
                  description: name,
                  parameters: Type.Object({}),
                  execute() {
                    executed.push(name);
                    return Promise.resolve({
                      content: [{ type: "text" as const, text: name }],
                      details: {},
                    });
                  },
                });
              pi.on("before_agent_start", (event) => {
                if (event.prompt === "use alpha")
                  event.systemPromptOptions.selectedTools = ["child_alpha"];
                if (event.prompt === "switch to beta")
                  event.systemPromptOptions.selectedTools = ["child_beta"];
              });
            },
          ],
        });
        const session = yield* scopedPrintSession({
          cwd: directory,
          agentDir: directory,
          model: fake.getModel(),
          modelRuntime: models,
          settingsManager: settings,
          sessionManager: SessionManager.open(forkFile),
          resourceLoader: loader,
          tools: [...childToolPolicy(["child_alpha", "child_beta"]).enabled],
          excludeTools: childToolPolicy([]).excluded.split(","),
        });
        // Provider callbacks inspect normalized transcripts produced by Pi, never cast brands.
        fake.setResponses([
          (context) => {
            expect(getCurrentSystemPrompt(context.messages)).toContain("child-only instruction");
            expect(getCurrentSystemPrompt(context.messages)).not.toContain("parent-only");
            expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
              "child_alpha",
            ]);
            return fauxAssistantMessage(fauxToolCall("child_alpha", {}), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("alpha done"),
          (context) => {
            expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
              "child_beta",
            ]);
            return fauxAssistantMessage(fauxToolCall("child_beta", {}), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("beta done"),
          (context) => {
            expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
              "child_alpha",
            ]);
            return fauxAssistantMessage(fauxToolCall("child_alpha", {}), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("alpha restored"),
        ]);
        yield* Effect.promise(() => session.prompt("use alpha"));
        const alphaLeaf = session.sessionManager.getLeafId()!;
        yield* Effect.promise(() => session.prompt("switch to beta"));
        expect(session.agent.state.tools.map((tool) => tool.name)).toEqual(["child_beta"]);
        expect(
          yield* Effect.promise(() => session.navigateTree(alphaLeaf, { summarize: false })),
        ).toMatchObject({
          cancelled: false,
        });
        expect(session.agent.state.tools.map((tool) => tool.name)).toEqual(["child_alpha"]);
        yield* Effect.promise(() => session.prompt("use restored alpha"));
        expect(executed).toEqual(["child_alpha", "child_beta", "child_alpha"]);
        expect(fake.getPendingResponseCount()).toBe(0);
        const restored = SessionManager.open(forkFile).buildSessionContext().messages;
        expect(getCurrentSystemPrompt(restored)).toContain("child-only instruction");
        expect(getCurrentTools(restored).map((tool) => tool.name)).toEqual(["child_alpha"]);
      }),
    15_000,
  );
});
