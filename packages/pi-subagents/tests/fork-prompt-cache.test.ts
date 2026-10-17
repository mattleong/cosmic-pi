import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { Type } from "typebox";
import {
  forkPromptCacheRoute,
  registerForkPromptCacheHooks,
} from "../src/boundary/fork-prompt-cache.ts";

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
const responses = modelFixture({
  provider: "openai",
  id: "gpt-additive",
  api: "openai-responses",
  compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
});

const forkContext = (model = responses) =>
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

const forkedRequest = (): ContextWithSystemEvent["messages"] => [
  {
    role: "system",
    content: "",
    sections: { preamble: "parent prompt" },
    toolsAdded: [declaration("parent_only"), declaration("shared", "parent definition")],
    timestamp: FORKED_AT - 10,
  },
  { role: "user", content: "parent question", timestamp: FORKED_AT - 5 },
  {
    role: "system",
    content: "",
    sections: { preamble: "child prompt" },
    toolsRemoved: [{ name: "parent_only" }, { name: "shared" }],
    toolsAdded: [declaration("shared", "child definition"), declaration("contact_parent")],
    timestamp: FORKED_AT + 1,
  },
  { role: "user", content: "assigned task", timestamp: FORKED_AT + 2 },
];

describe("fork prompt cache sharing", () => {
  it("keeps a fork on its parent's prefix only where the transport can carry the child's changes", () => {
    expect(forkPromptCacheRoute(anthropicNative)).toBe("native");
    expect(forkPromptCacheRoute(responses)).toBe("declared");
    for (const model of [
      modelFixture({ api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } }),
      modelFixture({
        api: "openai-codex-responses",
        compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
      }),
      modelFixture({ api: "openai-responses", compat: { supportsAdditionalTools: true } }),
      modelFixture({ api: "openai-responses" }),
    ])
      expect(forkPromptCacheRoute(model)).toBeUndefined();
  });

  it("leaves children that do not share a prompt cache unchanged", () => {
    const handlers = hooks({});
    expect(handlers.has("before_provider_request")).toBe(false);
    expect(handlers.has("context_with_system")).toBe(false);
  });

  it.effect(
    "keeps the parent's tool declarations while a declared-route request starts with them",
    () =>
      Effect.gen(function* () {
        const [handler] = hooks({ PI_SUBAGENT_PROMPT_CACHE_KEY: "parent-session" }).get(
          "context_with_system",
        );
        const project = (messages: ContextWithSystemEvent["messages"], model = responses) =>
          Effect.promise(() =>
            Promise.resolve(
              handler?.({ type: "context_with_system", messages }, forkContext(model)),
            ),
          );
        const messages = forkedRequest();
        const projected = yield* project(messages);
        expect(projected?.messages?.[2]).toEqual({
          role: "system",
          content: "",
          sections: { preamble: "child prompt" },
          toolsAdded: [declaration("contact_parent")],
          timestamp: FORKED_AT + 1,
        });
        expect(getCurrentTools(projected?.messages ?? [])).toEqual([
          declaration("parent_only"),
          declaration("shared", "parent definition"),
          declaration("contact_parent"),
        ]);
        expect(messages).toEqual(forkedRequest());

        expect(yield* project(messages, anthropicNative)).toBeUndefined();
        expect(yield* project(messages.slice(2))).toBeUndefined();
      }),
  );
});
