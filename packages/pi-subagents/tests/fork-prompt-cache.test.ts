import {
  getCurrentTools,
  normalizeContext,
  resolveTranscriptTools,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  convertResponsesMessages,
  getResponsesToolSupport,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm, type ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { Type } from "typebox";
import { registerForkPromptCacheHooks } from "../src/boundary/fork-prompt-cache.ts";

const FORK_HEADER_TIMESTAMP = "2026-10-14T00:00:00.000Z";
const FORKED_AT = Date.parse(FORK_HEADER_TIMESTAMP);

const declaration = (name: string, description = name) => ({
  name,
  description,
  parameters: Type.Object({}),
});

const anthropicNative = modelFixture({
  provider: "anthropic",
  id: "claude-native",
  api: "anthropic-messages",
  compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
});
const ADDITIONAL_TOOLS = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
const additionalTools = modelFixture({
  provider: "openai",
  id: "gpt-additional-tools",
  api: "openai-responses",
  compat: ADDITIONAL_TOOLS,
});
const TOOL_SEARCH = { supportsMidConvoSystemMessages: true, supportsToolSearch: true };
const toolSearch = modelFixture({
  provider: "openai",
  id: "gpt-tool-search",
  api: "openai-responses",
  compat: TOOL_SEARCH,
});

const forkContext = (model: Model<Api>) =>
  extensionContextFixture({
    model,
    sessionManager: {
      getHeader: () => ({
        type: "session",
        id: "child-session",
        timestamp: FORK_HEADER_TIMESTAMP,
        cwd: "/project",
      }),
    },
  });

const hooks = (environment: NodeJS.ProcessEnv) => {
  const host = recordingExtensionHost();
  registerForkPromptCacheHooks(host.pi, environment);
  return host.handlers;
};

type RequestMessages = ContextWithSystemEvent["messages"];

const parentRequest = (): RequestMessages => [
  {
    role: "system",
    content: "",
    sections: { preamble: "parent prompt" },
    toolsAdded: [declaration("parent_only"), declaration("shared", "parent definition")],
    timestamp: FORKED_AT - 10,
  },
  { role: "user", content: "parent question", timestamp: FORKED_AT - 5 },
];

const forkedRequest = (): RequestMessages => [
  ...parentRequest(),
  {
    role: "system",
    content: "",
    sections: { preamble: "child prompt" },
    toolsRemoved: [{ name: "parent_only" }, { name: "shared" }],
    toolsAdded: [declaration("shared", "child definition"), declaration("agent_contact_parent")],
    timestamp: FORKED_AT + 1,
  },
  { role: "user", content: "assigned task", timestamp: FORKED_AT + 2 },
];

const project = (messages: RequestMessages, model: Model<Api>) => {
  const [handler] = hooks({ PI_SUBAGENT_PROMPT_CACHE_KEY: "parent-session" }).get(
    "context_with_system",
  );
  return Effect.promise(() =>
    Promise.resolve(handler?.({ type: "context_with_system", messages }, forkContext(model))),
  );
};

// Pi's own Responses conversion: the request-level tools, then the input items, form the prefix
// the provider caches.
const responsesRequest = (
  model: Model<Api>,
  compat: typeof ADDITIONAL_TOOLS | typeof TOOL_SEARCH,
  messages: RequestMessages,
) => {
  const llmMessages = convertToLlm(messages);
  return {
    tools: resolveTranscriptTools(llmMessages, getResponsesToolSupport(compat)).requestTools,
    input: convertResponsesMessages(
      model,
      normalizeContext({ messages: llmMessages }),
      new Set([model.provider]),
      compat,
    ),
  };
};

const expectSharedPrefix = (
  parent: ReturnType<typeof responsesRequest>,
  child: ReturnType<typeof responsesRequest>,
) => {
  expect(child.tools).toEqual(parent.tools);
  expect(child.input.slice(0, parent.input.length)).toEqual(parent.input);
};

describe("fork prompt cache sharing", () => {
  it.effect(
    "keeps the parent's tool declarations on tool-search requests that start with them",
    () =>
      Effect.gen(function* () {
        const messages = forkedRequest();
        const projected = (yield* project(messages, toolSearch))?.messages;
        expect(projected?.[2]).toEqual({
          role: "system",
          content: "",
          sections: { preamble: "child prompt" },
          toolsAdded: [declaration("agent_contact_parent")],
          timestamp: FORKED_AT + 1,
        });
        expect(getCurrentTools(projected ?? [])).toEqual([
          declaration("parent_only"),
          declaration("shared", "parent definition"),
          declaration("agent_contact_parent"),
        ]);
        expect(messages).toEqual(forkedRequest());
        expectSharedPrefix(
          responsesRequest(toolSearch, TOOL_SEARCH, parentRequest()),
          responsesRequest(toolSearch, TOOL_SEARCH, projected ?? []),
        );

        expect(yield* project(messages.slice(2), toolSearch)).toBeUndefined();
      }),
  );

  it.effect(
    "leaves the child's own tool changes on routes that carry them after the parent's prefix",
    () =>
      Effect.gen(function* () {
        expect(yield* project(forkedRequest(), anthropicNative)).toBeUndefined();
        expect(yield* project(forkedRequest(), additionalTools)).toBeUndefined();
        expectSharedPrefix(
          responsesRequest(additionalTools, ADDITIONAL_TOOLS, parentRequest()),
          responsesRequest(additionalTools, ADDITIONAL_TOOLS, forkedRequest()),
        );
      }),
  );
});
