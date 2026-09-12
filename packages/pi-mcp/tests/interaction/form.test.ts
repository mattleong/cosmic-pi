import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { prepareElicitation, safeElicitationUrl } from "../../src/interaction/form.ts";

it.effect(
  "maps the official titled multi-select shape and primitive defaults without compiling schemas",
  () =>
    Effect.gen(function* () {
      const prepared = yield* prepareElicitation({
        method: "elicitation/create",
        params: {
          message: "Choose",
          requestedSchema: {
            type: "object",
            properties: {
              colors: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                  anyOf: [
                    { const: "red", title: "Red" },
                    { const: "blue", title: "Blue" },
                  ],
                },
                default: ["red"],
              },
              count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
              enabled: { type: "boolean", default: true },
            },
            required: ["colors"],
          },
        },
      });
      expect(prepared.request).toMatchObject({
        kind: "form",
        fields: [
          {
            key: "colors",
            type: "multi-enum",
            options: [
              { value: "red", title: "Red" },
              { value: "blue", title: "Blue" },
            ],
            default: ["red"],
            required: true,
          },
          { key: "count", type: "integer", default: 2 },
          { key: "enabled", type: "boolean", default: true },
        ],
      });
    }),
);

it.effect.each([
  { type: "object", properties: { password: { type: "string" } } },
  { type: "object", properties: { nested: { type: "object", properties: {} } } },
  { type: "object", properties: { list: { type: "array", items: { type: "string" } } } },
  { type: "object", properties: { unknown: { type: "string", pattern: ".*" } } },
  { type: "object", properties: { count: { type: "number", enum: ["one"] } } },
])("rejects unsupported/sensitive schema before any UI: %j", (requestedSchema) =>
  Effect.gen(function* () {
    const failure = yield* prepareElicitation({
      method: "elicitation/create",
      params: { message: "Provide information", requestedSchema },
    }).pipe(Effect.flip);
    expect(failure).toMatchObject({ kind: "unsupported", outcome: "unknown" });
    expect(failure.message).not.toContain("password");
  }),
);

it.each([
  "https://example.test/path",
  "http://127.0.0.1:8000",
  "http://[::1]:8000",
  "http://localhost:8000",
])("accepts secure explicit browser destination %s", (url) =>
  expect(safeElicitationUrl(url)).toBe(true),
);
it.each([
  "javascript:alert(1)",
  "file:///etc/passwd",
  "http://remote.test",
  "https://user:secret@example.test",
  "https://example.test/\n",
  "https://example.test/a b",
])("rejects unsafe browser destination %s", (url) => expect(safeElicitationUrl(url)).toBe(false));
