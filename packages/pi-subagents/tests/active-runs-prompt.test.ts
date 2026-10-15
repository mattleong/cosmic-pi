import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import {
  fauxModels,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "pi-cosmic-core/testing/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import {
  ACTIVE_RUNS_PROMPT_SECTION,
  activeRunsSection,
  keepsMidConversationSystemMessages,
  registerActiveRunsPrompt,
} from "../src/boundary/host-active-runs-prompt.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { beforeAgentStartEvent } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

const reviewer = view({
  id: "agent-1",
  name: "auth-review",
  profile: "reviewer",
  state: "running",
});
const scout = view({ id: "agent-2", name: "map-api", profile: "scout", state: "running" });

const keepingModel = modelFixture({
  api: "anthropic-messages",
  compat: { supportsMidConvoSystemMessages: true },
});
const mergingModel = modelFixture({ api: "anthropic-messages" });

const compactionEntry = (id: string): SessionEntry => ({
  type: "compaction",
  id,
  parentId: null,
  timestamp: "1970-01-01T00:00:00.000Z",
  summary: "Earlier work.",
  firstKeptEntryId: id,
  tokensBefore: 1,
});

const promptHarness = (initial: SubagentProjection) => {
  let projection = initial;
  let branch: ReadonlyArray<SessionEntry> = [];
  const { pi, emit } = recordingExtensionHost();
  registerActiveRunsPrompt(pi, () => projection);
  const section = (model: ExtensionContext["model"], selectedTools = ["subagent_start"]) =>
    Effect.gen(function* () {
      const event = beforeAgentStartEvent("go", { selectedTools });
      const ctx = extensionContextFixture({
        model,
        sessionManager: { getSessionId: () => "session-1", getBranch: () => [...branch] },
      });
      yield* Effect.promise(() => emit("before_agent_start", ctx, event));
      return event.systemPromptOptions.sections[ACTIVE_RUNS_PROMPT_SECTION];
    });
  return {
    section,
    setProjection: (next: SubagentProjection) => {
      projection = next;
    },
    compact: (id: string) => {
      branch = [...branch, compactionEntry(id)];
    },
  };
};

describe("active subagents prompt section", () => {
  it("lists only active direct children and ignores volatile progress", () => {
    const nested = view({ id: "agent-2", parentRunId: "agent-1", state: "running" });
    const done = view({ id: "agent-3", state: "completed" });
    const section = activeRunsSection(projectionOf([reviewer, nested, done]));
    expect(section).toContain("agent-1 · reviewer · auth-review · running");
    expect(section).not.toContain("agent-2");
    expect(section).not.toContain("agent-3");
    const later = activeRunsSection(
      projectionOf([{ ...reviewer, lastActivityAt: 99, progress: "read 40 files" }, nested, done]),
    );
    expect(later).toBe(section);
    expect(activeRunsSection(projectionOf([done]))).toBeUndefined();
  });

  it("recognizes models that keep mid-conversation system messages", () => {
    expect(keepsMidConversationSystemMessages(keepingModel)).toBe(true);
    expect(
      keepsMidConversationSystemMessages(
        modelFixture({
          api: "openai-codex-responses",
          compat: { supportsMidConvoSystemMessages: true },
        }),
      ),
    ).toBe(true);
    expect(keepsMidConversationSystemMessages(mergingModel)).toBe(false);
    expect(
      keepsMidConversationSystemMessages(
        modelFixture({
          api: "bedrock-converse-stream",
          compat: { supportsMidConvoSystemMessages: true },
        }),
      ),
    ).toBe(false);
    expect(keepsMidConversationSystemMessages(undefined)).toBe(false);
  });

  it.effect("tracks live state while the model keeps mid-conversation system messages", () =>
    Effect.gen(function* () {
      const harness = promptHarness(projectionOf([reviewer]));
      expect(yield* harness.section(keepingModel)).toContain("agent-1");
      expect(yield* harness.section(keepingModel, ["read"])).toBeUndefined();
      harness.setProjection(projectionOf([{ ...reviewer, state: "waiting_for_parent" }]));
      expect(yield* harness.section(keepingModel)).toContain("waiting for your reply");
      harness.setProjection(projectionOf([{ ...reviewer, state: "completed" }]));
      expect(yield* harness.section(keepingModel)).toBeUndefined();
    }),
  );

  it.effect("changes the section only at compaction when the model merges system messages", () =>
    Effect.gen(function* () {
      const harness = promptHarness(projectionOf([reviewer]));
      expect(yield* harness.section(mergingModel)).toBeUndefined();
      harness.compact("compaction-1");
      const captured = yield* harness.section(mergingModel);
      expect(captured).toContain("agent-1 · reviewer · auth-review");
      expect(captured).not.toContain("running");
      harness.setProjection(projectionOf([{ ...reviewer, state: "waiting_for_parent" }, scout]));
      expect(yield* harness.section(mergingModel)).toBe(captured);
      harness.setProjection(projectionOf([{ ...reviewer, state: "completed" }, scout]));
      expect(yield* harness.section(mergingModel)).toBe(captured);
      harness.compact("compaction-2");
      const next = yield* harness.section(mergingModel);
      expect(next).toContain("agent-2");
      expect(next).not.toContain("agent-1");
    }),
  );
});

describe("active subagents section in a real Pi transcript", () => {
  it.live(
    "leaves the leading prompt byte-identical across child changes until compaction",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("pi-active-runs-");
        const { fake, models } = yield* fauxModels("active-runs-prompt-test");
        let projection = projectionOf([reviewer]);
        const settings = quietSettings({ compaction: { enabled: false, keepRecentTokens: 1 } });
        const loader = yield* quietLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          noExtensions: true,
          extensionFactories: [
            (pi) => {
              pi.registerTool({
                name: "subagent_start",
                label: "Start",
                description: "Start subagents",
                parameters: Type.Object({}),
                execute: () => Promise.resolve({ content: [], details: {} }),
              });
              registerActiveRunsPrompt(pi, () => projection);
              pi.on("session_before_compact", (event) => ({
                compaction: {
                  summary: "Earlier work.",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              }));
            },
          ],
        });
        const session = yield* scopedPrintSession({
          cwd: directory,
          agentDir: directory,
          model: fake.getModel(),
          modelRuntime: models,
          settingsManager: settings,
          sessionManager: SessionManager.inMemory(directory),
          resourceLoader: loader,
        });
        const requests: Array<{ readonly prompt: string; readonly systemMessages: number }> = [];
        const reply: Parameters<typeof fake.setResponses>[0][number] = (context) => {
          requests.push({
            prompt: getCurrentSystemPrompt(context.messages),
            systemMessages: context.messages.filter((message) => message.role === "system").length,
          });
          return fauxAssistantMessage("Noted.");
        };
        fake.setResponses([reply, reply, reply, reply]);
        const prompt = (text: string) => Effect.promise(() => session.prompt(text));

        yield* prompt("Start the review.");
        projection = projectionOf([{ ...reviewer, state: "waiting_for_parent" }, scout]);
        yield* prompt("A subagent asked a question.");
        yield* Effect.promise(() => session.compact());
        yield* prompt("Continue after compaction.");
        projection = projectionOf([{ ...reviewer, state: "completed" }, scout]);
        yield* prompt("A subagent finished.");

        const [first, second, third, fourth] = requests;
        expect(first?.prompt).not.toContain(ACTIVE_RUNS_PROMPT_SECTION);
        expect(second).toEqual(first);
        expect(third?.prompt).toContain("agent-1");
        expect(third?.prompt).toContain("agent-2");
        expect(fourth).toEqual(third);
        expect(fake.getPendingResponseCount()).toBe(0);
      }),
    15_000,
  );
});
