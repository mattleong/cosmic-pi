import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import type { FormOutcome, OwnedFormRequest, ExtensionFormOwner } from "pi-ask-user/protocol";
import type { McpInteractionHost } from "../../src/interaction/model.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { sseFrames, sseResponse, type FixtureRequest } from "../fixtures/json-rpc.ts";
import { optionalFixture, projection, reply } from "../fixtures/optional-features.ts";

const form = {
  method: "elicitation/create",
  params: {
    message: "Choose a label",
    requestedSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    },
  },
};
const input = {
  action: "tools.call",
  server: "fixture",
  tool: "example",
  arguments: { original: "kept" },
};
const provider = (
  ask: (request: OwnedFormRequest, owner: ExtensionFormOwner) => Effect.Effect<FormOutcome>,
): McpInteractionHost => ({
  resolve: Effect.succeed({
    current: Effect.succeed(true),
    ask,
    openBrowser: () => Effect.succeed(true),
  }),
});
const onToolCall = (result: Schema.JsonObject) => (request: FixtureRequest) =>
  request.method === "tools/call" ? reply(request.id!, result) : undefined;
const countingDecline = () => {
  let asks = 0;
  const host = provider(() =>
    Effect.sync(() => {
      asks++;
      return { action: "decline" };
    }),
  );
  return { host, asks: () => asks };
};

it.live(
  "runs fresh MRTR legs with original arguments, exact opaque state, absent-state reset and private answers",
  () => {
    const seen: OwnedFormRequest[] = [];
    let leg = 0;
    const fixture = optionalFixture(
      (request) => {
        if (request.method !== "tools/call") return undefined;
        const current = leg++;
        if (current === 0)
          return reply(request.id!, {
            resultType: "input_required",
            requestState: "opaque:private\\u0000==",
            inputRequests: { first: form },
          });
        if (current === 1)
          return reply(request.id!, {
            resultType: "input_required",
            requestState: "opaque:second",
          });
        if (current === 2)
          return reply(request.id!, {
            resultType: "input_required",
            inputRequests: { third: form },
          });
        return reply(request.id!, { content: [{ type: "text", text: "finished" }] });
      },
      {
        interaction: provider((request) =>
          Effect.sync(() => {
            seen.push(request);
            return { action: "accept", content: { label: "private-answer" } };
          }),
        ),
      },
    );
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      const result = yield* execution.execute(input, projection);
      expect(result.reply.outcome).toBe("completed");
      const legs = fixture.requests.filter((request) => request.method === "tools/call");
      expect(new Set(legs.map((request) => request.id)).size).toBe(4);
      expect(legs.map((request) => request.params?.arguments)).toEqual(
        Array.from({ length: 4 }, () => input.arguments),
      );
      expect(legs.map((request) => request.params?.requestState)).toEqual([
        undefined,
        "opaque:private\\u0000==",
        "opaque:second",
        undefined,
      ]);
      expect(legs[1]!.params?.inputResponses).toEqual({
        first: { action: "accept", content: { label: "private-answer" } },
      });
      expect(seen).toHaveLength(2);
      const retained = yield* execution.execute(
        { action: "result.read", id: result.reply.resultId },
        projection,
      );
      expect(serialize([result, retained])).not.toMatch(
        /opaque:|private-answer|inputRequests|inputResponses|requestedSchema/,
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.live.each(["unsupported", "malformed"])("rejects whole %s batches before any UI", (mode) => {
  const decline = countingDecline();
  const fixture = optionalFixture(
    onToolCall({
      resultType: "input_required",
      inputRequests: {
        first: form,
        second:
          mode === "unsupported"
            ? { method: "roots/list", params: {} }
            : { method: "elicitation/create", params: { message: "broken" } },
      },
    }),
    { interaction: decline.host },
  );
  return Effect.gen(function* () {
    const result = yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip);
    expect(result.outcome).toBe("unknown");
    expect(decline.asks()).toBe(0);
    expect(fixture.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});

it.live("decline handles maximum and prototype-looking request keys without reopening UI", () => {
  let asks = 0;
  const owners: ExtensionFormOwner[] = [];
  const requests = Object.fromEntries([
    ["x".repeat(256), form],
    ["__proto__", form],
  ]);
  const fixture = optionalFixture(
    onToolCall({ resultType: "input_required", inputRequests: requests }),
    {
      interaction: provider((_request, owner) =>
        Effect.sync(() => {
          owners.push(owner);
          asks++;
          return { action: "decline" };
        }),
      ),
    },
  );
  return Effect.gen(function* () {
    expect(yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip)).toMatchObject(
      { kind: "cancelled", outcome: "unknown" },
    );
    expect(asks).toBe(1);
    expect(owners[0]!.requestId.length).toBeLessThan(256);
    const legs = fixture.requests.filter((request) => request.method === "tools/call");
    expect(legs).toHaveLength(2);
    expect(legs[1]!.params?.inputResponses).toEqual(
      Object.fromEntries([
        ["x".repeat(256), { action: "decline" }],
        ["__proto__", { action: "cancel" }],
      ]),
    );
  }).pipe(Effect.provide(fixture.layer));
});

it.live.each(["cancel", "deadline", "credential"])(
  "stops continuation after %s during user input",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let token: string | undefined;
      let finalized = false;
      const host = provider(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          if (mode === "credential") {
            token = "replacement";
            return { action: "accept" as const, content: { label: "safe" } };
          }
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      const fixture = optionalFixture(
        onToolCall({
          resultType: "input_required",
          inputRequests: { first: form },
          requestState: "private",
        }),
        {
          interaction: host,
          auth: Effect.sync(() => token),
          // Long enough to reach user input on a slow runner; the prompt itself never answers.
          settings: { requestTimeoutMs: mode === "deadline" ? 2_000 : 60_000 },
        },
      );
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        const running = yield* Effect.forkScoped(
          execution.execute(input, projection).pipe(Effect.result),
        );
        // A request that ends before prompting fails the assertions below instead of hanging.
        yield* Effect.raceFirst(Deferred.await(entered), Fiber.await(running));
        if (mode === "cancel") yield* Fiber.interrupt(running);
        else {
          const result = yield* Fiber.join(running);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { kind: mode === "deadline" ? "timeout" : "stale", outcome: "unknown" },
          });
        }
        expect(finalized).toBe(true);
        expect(fixture.requests.filter((request) => request.method === "tools/call")).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.live("does not collect input when no continuation round remains", () => {
  let legs = 0;
  const decline = countingDecline();
  const fixture = optionalFixture(
    (request) => {
      if (request.method !== "tools/call") return undefined;
      const result = { resultType: "input_required", requestState: String(++legs) };
      return reply(request.id!, legs === 8 ? { ...result, inputRequests: { last: form } } : result);
    },
    { interaction: decline.host },
  );
  return Effect.gen(function* () {
    expect(yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip)).toMatchObject(
      { outcome: "unknown" },
    );
    expect(legs).toBe(8);
    expect(decline.asks()).toBe(0);
  }).pipe(Effect.provide(fixture.layer));
});

for (const kind of ["form", "url"] as const)
  it.live(
    `a sibling 401 prevents later ${kind} UI/browser work without revoking completed publication`,
    () => {
      let asks = 0;
      let browsers = 0;
      let wire = 0;
      let rejectOwner: Effect.Effect<void> = Effect.void;
      const host: McpInteractionHost = {
        resolve: Effect.succeed({
          current: Effect.succeed(true),
          ask: () =>
            rejectOwner.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  asks++;
                  return { action: "accept" as const, content: { label: "safe" } };
                }),
              ),
            ),
          openBrowser: () =>
            Effect.sync(() => {
              browsers++;
              return true;
            }),
        }),
      };
      const fixture = optionalFixture(
        (request) => {
          if (request.method !== "tools/call") return undefined;
          if (++wire > 1) return new Response(null, { status: 401 });
          return reply(request.id!, {
            resultType: "input_required",
            inputRequests:
              kind === "form"
                ? { first: form, second: form }
                : {
                    url: {
                      method: "elicitation/create",
                      params: {
                        mode: "url",
                        message: "Continue",
                        url: "https://example.test",
                        elicitationId: "id",
                      },
                    },
                  },
          });
        },
        { interaction: host },
      );
      return Effect.gen(function* () {
        const execution = yield* McpExecution;
        rejectOwner = execution.execute(input, projection).pipe(Effect.ignore);
        expect(yield* execution.execute(input, projection).pipe(Effect.flip)).toMatchObject({
          outcome: "unknown",
        });
        expect(asks).toBe(1);
        expect(browsers).toBe(0);
        expect(wire).toBe(2);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

it.live("fresh MRTR progress tokens restart at zero within one logical observation", () => {
  let leg = 0;
  const seen: number[] = [];
  const tokens: unknown[] = [];
  const fixture = optionalFixture(
    (request) => {
      if (request.method !== "tools/call") return undefined;
      const token = Schema.decodeUnknownSync(
        Schema.Struct({ progressToken: Schema.Union([Schema.String, Schema.Number]) }),
      )(request.params?._meta).progressToken;
      tokens.push(token);
      const current = leg++;
      const messages = [
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: current === 0 ? 100 : 0 },
        },
        {
          jsonrpc: "2.0",
          id: request.id,
          result:
            current === 0
              ? { resultType: "input_required", inputRequests: { first: form } }
              : { resultType: "complete", content: [{ type: "text", text: "done" }] },
        },
      ];
      return sseResponse(sseFrames(...messages));
    },
    {
      interaction: provider(() => Effect.succeed({ action: "accept", content: { label: "safe" } })),
    },
  );
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    yield* execution.execute(input, {
      ...projection,
      onProgress: (value) => seen.push(value.progress),
    });
    expect(new Set(tokens).size).toBe(2);
    expect(seen).toEqual([100, 0]);
    const events = yield* execution.execute(
      { action: "events.read", server: "fixture" },
      projection,
    );
    expect(events.reply.data).toMatchObject({
      result: { events: [expect.objectContaining({ progress: 0 })] },
    });
    expect(serialize(events.reply.data)).not.toContain('"leg"');
  }).pipe(Effect.provide(fixture.layer));
});
