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
  registerActiveRunsPrompt,
} from "../src/boundary/host-active-runs-prompt.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { beforeAgentStartEvent } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import { localServiceFixture, request, withService } from "./run/fixtures/service-harness.ts";

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
  const section = (model: ExtensionContext["model"], selectedTools = ["agent_start"]) =>
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
  it.effect("includes launched direct children in live and after-compaction prompts", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const direct = yield* service.start(
        request({ name: "direct-reviewer", profile: "reviewer" }),
      );
      const nested = yield* service.startSessionOwnedFrom(
        direct.id,
        request({ name: "nested-scout", profile: "scout" }),
      );
      const harness = promptHarness(yield* service.projection);
      const live = yield* harness.section(keepingModel);
      expect(live).toContain(direct.id);
      expect(live).not.toContain(nested.id);

      expect(yield* harness.section(mergingModel)).toBeUndefined();
      harness.compact("compaction-1");
      const compacted = yield* harness.section(mergingModel);
      expect(compacted).toContain(direct.id);
      expect(compacted).not.toContain(nested.id);
    });
  });
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
                name: "agent_start",
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
