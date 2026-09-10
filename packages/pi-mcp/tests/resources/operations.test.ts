import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import { boundaryError } from "../../src/client/errors.ts";
import type { McpRequest } from "../../src/client/model.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import { readResource } from "../../src/resources/operations.ts";

const operationFor = (sent: Array<McpRequest>, resources = true): McpOperation => {
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
    capabilities: { tools: false, resources, prompts: false },
    changes: Stream.never,
    checkCurrent: Effect.void,
    commit: (effect) => effect,
    request: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return {
          action: input.action,
          outcome: "completed",
          result: { contents: [{ uri: "returned://data", text: "untrusted resource" }] },
        };
      }),
    shared: (_key, use) => use(operation),
    forkOwned: (effect) => Effect.forkChild(effect),
  };
  return operation;
};

it.effect("passes file and HTTP resource URIs only to the selected server capability", () =>
  Effect.gen(function* () {
    const sent: Array<McpRequest> = [];
    const operation = operationFor(sent);
    for (const uri of [
      "file:///private/no-client-read",
      "http://127.0.0.1:1/no-client-fetch",
      "custom://opaque/value",
    ]) {
      const result = yield* readResource(operation, {
        action: "resources.read",
        server: "selected",
        uri,
      });
      expect(result).toMatchObject({
        outcome: "completed",
        result: { contents: [{ text: "untrusted resource" }] },
      });
    }
    expect(sent).toEqual([
      { action: "resources.read", uri: "file:///private/no-client-read" },
      { action: "resources.read", uri: "http://127.0.0.1:1/no-client-fetch" },
      { action: "resources.read", uri: "custom://opaque/value" },
    ]);
  }),
);

it.effect("rejects unsupported or revoked resource authority without dispatch", () =>
  Effect.gen(function* () {
    const sent: Array<McpRequest> = [];
    const input = {
      action: "resources.read" as const,
      server: "selected",
      uri: "file:///private/no-client-read",
    };
    expect(yield* readResource(operationFor(sent, false), input).pipe(Effect.flip)).toMatchObject({
      kind: "unsupported",
      outcome: "not-sent",
    });
    const revoked = {
      ...operationFor(sent),
      checkCurrent: Effect.fail(boundaryError("denied", "not-sent", "Revoked.")),
    };
    expect(yield* readResource(revoked, input).pipe(Effect.flip)).toMatchObject({ kind: "denied" });
    expect(sent).toHaveLength(0);
  }),
);
