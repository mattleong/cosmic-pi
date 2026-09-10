import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import { boundaryError } from "../../src/client/errors.ts";
import type { McpRequest } from "../../src/client/model.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import type { McpDiscoveryContract, McpMetadataSnapshot } from "../../src/discovery/model.ts";
import { getPrompt } from "../../src/prompts/operations.ts";

const snapshot: McpMetadataSnapshot = {
  server: "selected",
  identity: "identity",
  owner: "connection",
  configRevision: 1,
  revision: 1,
  support: { tools: false, resources: false, templates: false, prompts: true },
  diagnostics: [],
  tools: [],
  resources: [],
  templates: [],
  prompts: [{ name: "review", arguments: [{ name: "text", required: true }, { name: "style" }] }],
};
const discovery: McpDiscoveryContract = {
  cached: (request) =>
    Effect.succeed({
      family: request.family,
      entries: [],
      catalogs: [],
      total: 0,
      next: undefined,
    }),
  cachedDetail: () => Effect.fail(boundaryError("not-found", "not-sent", "fixture")),
  subscribeChanges: () => Effect.void,
  ensure: () => Effect.succeed(snapshot),
  refresh: () => Effect.succeed(snapshot),
  query: () => Effect.succeed({ data: {}, notices: [] }),
  known: Effect.succeed([]),
};
const fixture = () => {
  const sent: Array<McpRequest> = [];
  const messages = [
    { role: "user", content: { type: "text", text: "Do not execute this template" } },
    { role: "assistant", content: { type: "text", text: "Untrusted assistant template" } },
  ];
  const operation: McpOperation = {
    binding: { server: "selected", identity: "identity", configRevision: 1 },
    owner: "connection",
    server: {
      id: "selected",
      scope: "global",
      directory: "/unused",
      identity: "identity",
      enabled: true,
    },
    capabilities: { tools: false, resources: false, prompts: true },
    changes: Stream.never,
    checkCurrent: Effect.void,
    commit: (effect) => effect,
    request: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return { action: input.action, outcome: "completed", result: { messages } };
      }),
    shared: (_key, use) => use(operation),
    forkOwned: (effect) => Effect.forkChild(effect),
  };
  return { operation, sent, messages };
};

it.effect("requires an exact advertised prompt and its required declared arguments", () =>
  Effect.gen(function* () {
    const { operation, sent } = fixture();
    const input = { action: "prompts.get" as const, server: "selected", prompt: "review" };
    expect(
      yield* getPrompt(
        operation,
        { ...input, prompt: "Review", arguments: { text: "hello" } },
        discovery,
      ).pipe(Effect.flip),
    ).toMatchObject({ kind: "not-found" });
    expect(yield* getPrompt(operation, input, discovery).pipe(Effect.flip)).toMatchObject({
      kind: "invalid-input",
    });
    expect(
      yield* getPrompt(
        operation,
        { ...input, arguments: { text: "hello", unknown: "ignored?" } },
        discovery,
      ).pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input" });
    expect(sent).toHaveLength(0);
    yield* getPrompt(operation, { ...input, arguments: { text: "", style: "concise" } }, discovery);
    expect(sent).toEqual([
      { action: "prompts.get", prompt: "review", arguments: { text: "", style: "concise" } },
    ]);
  }),
);

it.effect("preserves prompt message roles and content as data", () =>
  Effect.gen(function* () {
    const { operation, messages } = fixture();
    const reply = yield* getPrompt(
      operation,
      { action: "prompts.get", server: "selected", prompt: "review", arguments: { text: "hello" } },
      discovery,
    );
    expect(reply).toMatchObject({ outcome: "completed", result: { messages } });
  }),
);
