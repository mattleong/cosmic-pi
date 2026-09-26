import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpExecution } from "../../src/tools/service.ts";
import { discovered, optionalFixture, projection, reply } from "../fixtures/optional-features.ts";

const input = {
  action: "completion.complete",
  server: "fixture",
  ref: { type: "ref/prompt", name: "example" },
  argument: { name: "value", value: "" },
};

it.live(
  "completes only advertised prompt and exact template arguments through the real SDK",
  () => {
    const fixture = optionalFixture();
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      for (const ref of [
        { type: "ref/prompt", name: "example" },
        { type: "ref/resource", uri: "test://{path}" },
      ] as const) {
        const result = yield* execution.execute(
          {
            action: "completion.complete",
            server: "fixture",
            ref,
            argument: { name: ref.type === "ref/prompt" ? "value" : "path", value: "o" },
          },
          projection,
        );
        expect(result.reply.data).toMatchObject({
          result: { completion: { values: ["one", "two"] } },
        });
      }
      for (const request of [
        { ref: { type: "ref/prompt", name: "missing" }, argument: { name: "value", value: "" } },
        { ref: { type: "ref/prompt", name: "example" }, argument: { name: "secret", value: "" } },
        { ref: { type: "ref/resource", uri: "test://one" }, argument: { name: "path", value: "" } },
        {
          ref: { type: "ref/resource", uri: "test://{path}" },
          argument: { name: "path", value: "" },
          context: { arguments: { other: "secret" } },
        },
      ]) {
        const failure = yield* execution
          .execute({ action: "completion.complete", server: "fixture", ...request }, projection)
          .pipe(Effect.flip);
        expect(failure.outcome).toBe("not-sent");
      }
      expect(
        fixture.requests.filter((request) => request.method === "completion/complete"),
      ).toHaveLength(2);
      expect(fixture.requests.some((request) => request.method === "resources/read")).toBe(false);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.live(
  "gates completions before metadata requests and rejects more than100 server suggestions",
  () => {
    const unsupported = optionalFixture((request) =>
      request.method === "server/discover"
        ? reply(request.id!, discovered({ prompts: {} }))
        : undefined,
    );
    const oversized = optionalFixture((request) =>
      request.method === "completion/complete"
        ? reply(request.id!, { completion: { values: Array.from({ length: 101 }, () => "value") } })
        : undefined,
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        expect(
          yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip),
        ).toMatchObject({ kind: "unsupported", outcome: "not-sent" });
        expect(unsupported.requests.map((request) => request.method)).toEqual(["server/discover"]);
      }).pipe(Effect.provide(unsupported.layer));
      yield* Effect.gen(function* () {
        expect(
          yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip),
        ).toMatchObject({ kind: "protocol", outcome: "completed" });
      }).pipe(Effect.provide(oversized.layer));
    });
  },
);

it.live("omitted prompt arguments advertise no completion argument or context authority", () => {
  const fixture = optionalFixture((request) =>
    request.method === "prompts/list"
      ? reply(request.id!, { prompts: [{ name: "example" }] })
      : undefined,
  );
  return Effect.gen(function* () {
    expect(
      yield* (yield* McpExecution)
        .execute({ ...input, argument: { name: "invented", value: "" } }, projection)
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
    expect(fixture.requests.some((request) => request.method === "completion/complete")).toBe(
      false,
    );
  }).pipe(Effect.provide(fixture.layer));
});

it.live(
  "a dispatched completion retains accepted certainty when trust changes before publication",
  () => {
    const fixture = optionalFixture((request) => {
      if (request.method !== "completion/complete") return undefined;
      fixture.revokeTrust();
      return reply(request.id!, { completion: { values: ["one"] } });
    });
    return Effect.gen(function* () {
      const result = yield* (yield* McpExecution).execute(input, projection).pipe(Effect.flip);
      expect(result.outcome).not.toBe("not-sent");
    }).pipe(Effect.provide(fixture.layer));
  },
);
