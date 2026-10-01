import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { Type } from "typebox";
import { describe, expect, it } from "@effect/vitest";
import { childToolPolicy, createForkedSession } from "../src/boundary/child-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "./support/node-builtins.ts";

describe("installed Pi transcript reconstruction", () => {
  it.live(
    "uses child prompt/tools and restores executable membership when navigating branches",
    () =>
      Effect.gen(function* () {
        const temporaryRoot = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"));
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(temporaryRoot, "pi-transcript-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const fake = fauxProvider({ provider: "subagent-transcript-test", tokensPerSecond: 0 });
        const models = yield* Effect.promise(() =>
          ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsStore: new InMemoryModelsStore(),
            modelsPath: null,
            refreshOnCreate: false,
            allowModelNetwork: false,
          }),
        );
        models.registerNativeProvider(fake.provider);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => models.unregisterProvider(fake.provider.id)),
        );
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
          {
            runId: "transcript",
            name: "transcript",
            cwd: directory,
            context: "fork",
            writeIntent: "read-only",
            openaiFastMode: false,
            model: "faux/faux",
            effort: "off",
            activeTools: ["child_alpha"],
            projectTrusted: false,
            parentSessionId: parent.getSessionId(),
            parentSessionFile: parent.getSessionFile()!,
            parentLeafId: parent.getLeafId()!,
            systemPrompt: "child-only instruction",
          },
          directory,
        );
        const settings = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const executed: string[] = [];
        const loader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
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
        yield* Effect.promise(() => loader.reload());
        const { session } = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createAgentSession({
              cwd: directory,
              agentDir: directory,
              model: fake.getModel(),
              modelRuntime: models,
              settingsManager: settings,
              sessionManager: SessionManager.open(forkFile),
              resourceLoader: loader,
              tools: [...childToolPolicy(["child_alpha", "child_beta"]).enabled],
              excludeTools: childToolPolicy([]).excluded.split(","),
            }),
          ),
          ({ session }) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => session.abort());
              yield* Effect.promise(() =>
                session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => session.dispose()))),
        );
        yield* Effect.promise(() => session.bindExtensions({ mode: "print" }));
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
