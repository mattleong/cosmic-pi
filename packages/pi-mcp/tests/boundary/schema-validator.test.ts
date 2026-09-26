import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/unstable/http";
import { runBoundedProcessNode, type BoundedProcessResult } from "pi-cosmic-core";
import { startHttpServer } from "../fixtures/http-server.ts";
import {
  makeJsonSchemaValidator,
  type JsonSchemaProcessRunner,
} from "../../src/boundary/schema-validator.ts";
import { JSON_SCHEMA_VALIDATOR_LIMITS } from "../../src/validation/schema-policy.ts";

const jsonStringSchema = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeSync(jsonStringSchema);
const decodeJson = Schema.decodeUnknownSync(jsonStringSchema);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const runHelper = (schema: Schema.Json, data: Schema.Json) =>
  runBoundedProcessNode({
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("../../src/boundary/schema-validator-helper.mjs", import.meta.url)),
    ],
    stdin: new TextEncoder().encode(encodeJson({ schema, data })),
    stdoutLimitBytes: 4096,
    stderrLimitBytes: 256,
    totalOutputLimitBytes: 4352,
    timeoutMillis: 2000,
    cleanupTimeoutMillis: 2000,
  });

const processResult = (stdout: string, overrides?: Partial<BoundedProcessResult>) =>
  ({
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    overflowed: false,
    timedOut: false,
    cleanupUnconfirmed: false,
    ...overrides,
  }) satisfies BoundedProcessResult;

/** A helper stand-in that reports `confirmed` cleanup and counts its admissions. */
const countingRunner = (
  stdout = '{"valid":true}',
  {
    confirmed = true,
    ...overrides
  }: Partial<BoundedProcessResult> & { readonly confirmed?: boolean } = {},
) => {
  let calls = 0;
  const runner: JsonSchemaProcessRunner = (_input, onCleanup) =>
    Effect.sync(() => {
      calls += 1;
      onCleanup(confirmed);
      return processResult(stdout, overrides);
    });
  return { runner, calls: () => calls };
};
const fixedRunner = (stdout: string, overrides?: Partial<BoundedProcessResult>) =>
  countingRunner(stdout, overrides).runner;
/** The helper refuses the schema without emitting output or leaving uncertain cleanup. */
const expectSilentRejection = (result: BoundedProcessResult) => {
  expect(result.code).not.toBe(0);
  expect(result).toMatchObject({ stdout: "", stderr: "", cleanupUnconfirmed: false });
};

it.live("validates remote input through the packaged SDK helper", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
    };

    yield* validator.validateJsonSchema(schema, { name: "Ada", age: 37 }, "not-sent");
    expect(
      yield* validator.validateJsonSchema(schema, { name: 37 }, "not-sent").pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
  }),
);

it.live("accepts the full bounded completed data allowance through the packaged helper", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    // Quotes count toward the 8 MiB serialized document limit.
    const data = "x".repeat(JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes - 2);
    yield* validator.validateJsonSchema({ type: "string" }, data, "completed");
  }),
);

it.effect(
  "bounds input documents before helper admission and preserves output operation certainty",
  () =>
    Effect.gen(function* () {
      const { runner, calls } = countingRunner();
      const validator = yield* makeJsonSchemaValidator({ processRunner: runner });
      let deep: Schema.Json = null;
      for (let depth = 0; depth <= JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentDepth; depth += 1)
        deep = [deep];
      const oversized = "x".repeat(JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes + 1);
      let getterAccesses = 0;
      const getterData: Record<string, Schema.Json> = {};
      Object.defineProperty(getterData, "secret", {
        enumerable: true,
        get: () => {
          getterAccesses += 1;
          throw new Error("getter must not run");
        },
      });
      const cyclicData: Record<string, Schema.Json> = {};
      cyclicData.self = cyclicData;
      const inputs: ReadonlyArray<Schema.Json> = [
        "\u0000".repeat(Math.floor(JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes / 6) + 1),
        Array.from({ length: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentNodes }, () => null),
        deep,
        oversized,
        getterData,
        cyclicData,
      ];
      for (const input of inputs) {
        for (const outcome of ["not-sent", "completed"] as const) {
          expect(
            yield* validator.validateJsonSchema(true, input, outcome).pipe(Effect.flip),
          ).toMatchObject({ kind: "invalid-input", outcome });
        }
      }
      expect(getterAccesses).toBe(0);
      expect(calls()).toBe(0);

      const outputValidator = yield* makeJsonSchemaValidator({
        processRunner: fixedRunner('{"valid":false}'),
      });
      expect(
        yield* outputValidator
          .validateJsonSchema({ type: "string" }, 1, "completed")
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "protocol", outcome: "completed" });
      expect(
        yield* outputValidator
          .validateJsonSchema({ type: "string" }, oversized, "completed")
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "invalid-input", outcome: "completed" });
    }),
);

it.live("supports nested local references without changing arguments", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const schema = {
      $defs: {
        count: { type: "integer", minimum: 1 },
        item: {
          type: "object",
          properties: { count: { $ref: "#/$defs/count" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/item",
    };
    const data = { count: 2 };
    const before = encodeJson(data);

    expect(yield* validator.validateJsonSchema(schema, data, "not-sent")).toBeUndefined();
    expect(encodeJson(data)).toBe(before);
    expect(
      yield* validator.validateJsonSchema(schema, { count: 0 }, "not-sent").pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input" });
  }),
);

it.live("preserves nested nulls and rejects unsupported __proto__ schema properties", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const nestedSchema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { enum: [null], default: null } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      required: ["nested"],
      additionalProperties: false,
    };
    const nestedData = { nested: { value: null } };
    expect(
      yield* validator.validateJsonSchema(nestedSchema, nestedData, "not-sent"),
    ).toBeUndefined();
    expect(yield* validator.validateJsonSchema({ enum: [null] }, null, "not-sent")).toBeUndefined();
    const protoData = decodeJson('{"__proto__":{"value":null}}');
    const protoBefore = encodeJson(protoData);
    expect(
      yield* validator.validateJsonSchema(
        { type: "object", additionalProperties: true },
        protoData,
        "not-sent",
      ),
    ).toBeUndefined();
    expect(encodeJson(protoData)).toBe(protoBefore);

    const { runner, calls } = countingRunner();
    const policyValidator = yield* makeJsonSchemaValidator({ processRunner: runner });
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "object" } },
      required: ["__proto__"],
    };
    const data = decodeJson('{"__proto__":{"value":null}}');
    const before = encodeJson(data);
    expect(
      yield* policyValidator.validateJsonSchema(schema, data, "not-sent").pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
    expect(encodeJson(data)).toBe(before);
    expect(calls()).toBe(0);
  }),
);

it.effect("rejects async extensions and malformed constraints before process admission", () =>
  Effect.gen(function* () {
    const { runner, calls } = countingRunner();
    const validator = yield* makeJsonSchemaValidator({ processRunner: runner });
    for (const schema of [
      { $async: true, type: "string" },
      { $ref: "#/annotation", annotation: { $async: true, type: "string" } },
      { required: [1] },
      { format: 1 },
      { type: "string", nullable: true },
      { properties: { a: { nullable: true } } },
      { $vocabulary: { "https://example.test/required-vocabulary": true } },
      { contentSchema: 1 },
      { properties: { a: { $schema: "https://json-schema.org/draft-07/schema" } } },
      { $id: "https://json-schema.org/draft/2020-12/schema", type: "integer" },
      decodeJson('{"dependencies":{"__proto__":{"type":"string"}}}'),
    ]) {
      expect(
        yield* validator.validateJsonSchema(schema, {}, "not-sent").pipe(Effect.flip),
      ).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
    }
    expect(calls()).toBe(0);
  }),
);

it.live("resolves identifiers locally without loading external schemas", () =>
  Effect.gen(function* () {
    const server = yield* startHttpServer(() => Effect.succeed(HttpServerResponse.text("true")));
    const validator = yield* makeJsonSchemaValidator();
    const id = server.url.href;
    for (const ref of ["#/$defs/count", "count", new URL("count", id).href]) {
      const schema = {
        $id: id,
        $defs: { count: { $id: "count", type: "integer", minimum: 1 } },
        $ref: ref,
      };
      yield* validator.validateJsonSchema(schema, 1, "not-sent");
      expect(
        yield* validator.validateJsonSchema(schema, 0, "completed").pipe(Effect.flip),
      ).toMatchObject({ kind: "protocol", outcome: "completed" });
    }
    yield* validator.validateJsonSchema(
      {
        $id: "urn:example:count",
        $defs: { count: { $anchor: "count", type: "integer" } },
        $ref: "#count",
      },
      1,
      "not-sent",
    );
    for (const ref of [id, `${id}#/missing`, "file:///tmp/schema.json", "missing.json"]) {
      expect(
        yield* validator.validateJsonSchema({ $ref: ref }, {}, "completed").pipe(Effect.flip),
      ).toMatchObject({ kind: "unavailable", outcome: "completed" });
    }
    expect(server.requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("keeps content and custom annotations inert while enforcing ordinary constraints", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const schema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          minLength: 2,
          pattern: "^[a-z ]+$",
          default: "default",
          contentEncoding: "base64",
          contentMediaType: "application/json",
          contentSchema: false,
          format: "custom-annotation-format",
          "x-executable": "not executed",
          custom: { $ref: "https://example.test/annotation-only" },
        },
      },
      required: ["value"],
      additionalProperties: false,
    };
    yield* validator.validateJsonSchema(
      {
        $vocabulary: {
          "https://json-schema.org/draft/2020-12/vocab/core": true,
          "https://example.test/optional-vocabulary": false,
        },
        type: "string",
      },
      "annotation",
      "not-sent",
    );
    const data = { value: "not encoded or json" };
    const before = encodeJson({ schema, data });
    yield* validator.validateJsonSchema(schema, data, "not-sent");
    expect(encodeJson({ schema, data })).toBe(before);
    for (const invalid of [
      {},
      { value: 12 },
      { value: "a" },
      { value: "AA" },
      { ...data, extra: 1 },
    ]) {
      expect(
        yield* validator.validateJsonSchema(schema, invalid, "not-sent").pipe(Effect.flip),
      ).toMatchObject({ kind: "invalid-input" });
    }
    expect(
      yield* validator
        .validateJsonSchema({ type: "string", format: "email" }, "not an email", "not-sent")
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input" });
  }),
);

it.live("uses 2020-12 by default and honors supported dialect aliases and tuple rules", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const modern = { type: "array", prefixItems: [{ type: "integer" }], items: false };
    const dialects = [
      undefined,
      "http://json-schema.org/draft/2020-12/schema#",
      "https://json-schema.org/draft/2019-09/schema#",
      "http://json-schema.org/draft-07/schema",
      "https://json-schema.org/draft-06/schema",
    ];
    for (const dialect of dialects) {
      const schema =
        dialect === undefined
          ? modern
          : {
              $schema: dialect,
              ...(dialect.includes("2020-12")
                ? modern
                : {
                    type: "array",
                    items: [{ type: "integer" }],
                    additionalItems: false,
                  }),
            };
      yield* validator.validateJsonSchema(schema, [1], "not-sent");
      for (const data of [["bad"], [1, 2]]) {
        expect(
          yield* validator.validateJsonSchema(schema, data, "not-sent").pipe(Effect.flip),
        ).toMatchObject({ kind: "invalid-input" });
      }
    }
    const modernObject = {
      allOf: [{ properties: { count: { type: "integer" } } }],
      dependentRequired: { count: ["label"] },
      properties: { label: { type: "string" } },
      unevaluatedProperties: false,
    };
    yield* validator.validateJsonSchema(modernObject, { count: 1, label: "a" }, "not-sent");
    for (const data of [{ count: 1 }, { count: 1, label: "a", extra: true }]) {
      expect(
        yield* validator.validateJsonSchema(modernObject, data, "not-sent").pipe(Effect.flip),
      ).toMatchObject({ kind: "invalid-input" });
    }
    const dependencies = { dependencies: { count: ["label"], label: { required: ["count"] } } };
    yield* validator.validateJsonSchema(dependencies, { count: 1, label: "a" }, "not-sent");
    expect(
      yield* validator
        .validateJsonSchema(dependencies, { label: "a" }, "not-sent")
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input" });
  }),
);

it.live("enforces dynamic and recursive references in their supported dialects", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    for (const schema of [
      {
        $dynamicAnchor: "node",
        type: "object",
        properties: {
          value: { type: "integer" },
          child: { $dynamicRef: "#node" },
        },
      },
      {
        $schema: "https://json-schema.org/draft/2019-09/schema",
        $recursiveAnchor: true,
        type: "object",
        properties: {
          value: { type: "integer" },
          child: { $recursiveRef: "#" },
        },
      },
    ]) {
      yield* validator.validateJsonSchema(schema, { child: { value: 1 } }, "not-sent");
      expect(
        yield* validator
          .validateJsonSchema(schema, { child: { value: "bad" } }, "completed")
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "protocol", outcome: "completed" });
    }
  }),
);

it.live(
  "the direct helper cannot use async schemas or cached metaschemas to bypass constraints",
  () =>
    Effect.gen(function* () {
      for (const schema of [
        { $async: true, type: "integer" },
        { $ref: "#/annotation", annotation: { $async: true, type: "integer" } },
        { $id: "https://json-schema.org/draft/2020-12/schema", type: "integer" },
        { $id: "HTTP://JSON-SCHEMA.ORG/draft/2020-12/schema#/$defs/schemaArray", type: "integer" },
        {
          $schema: "https://json-schema.org/draft/2019-09/schema",
          $id: "https://json-schema.org/draft/2019-09/schema",
          type: "integer",
        },
        {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "http://json-schema.org/draft-07/schema#",
          type: "integer",
        },
        { $vocabulary: { "https://example.test/required-vocabulary": true } },
      ]) {
        expectSilentRejection(yield* runHelper(schema, {}));
      }
    }),
);

it.live("guards annotation nodes promoted through pointers, identifiers, and anchors", () =>
  Effect.gen(function* () {
    for (const target of [
      { type: "string", nullable: true },
      { $vocabulary: { "https://example.test/required-vocabulary": true } },
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "array",
        items: [{ type: "integer" }],
        additionalItems: false,
      },
    ]) {
      for (const schema of [
        {
          type: "object",
          properties: { value: { $ref: "#/x" } },
          required: ["value"],
          x: target,
        },
        { $ref: "#/x/a~1b~0c%20d", x: { "a/b~c d": target } },
        { $ref: "#/x/0", x: [{ $ref: "#/y" }], y: target },
        { $ref: "#/const", const: target },
        { $ref: "#/examples/0", examples: [target] },
        { $ref: "#/annotation/x", annotation: { $id: "child", ...target, x: true } },
        {
          $id: "https://example.test/root",
          $ref: "child#/x",
          annotation: { $id: "child", x: target },
        },
        {
          $id: "https://example.test/root",
          $ref: "child#value",
          annotation: { $id: "child", x: { $anchor: "value", ...target } },
        },
        { $ref: "#value", annotation: { $id: "#value", ...target } },
        { $ref: "#/x", annotation: { $id: "#/x", ...target } },
        {
          $id: "https://example.test/root",
          $ref: "child#/x",
          annotation: { $id: "child", ...target, x: { type: "string" } },
        },
        {
          $id: "https://example.test/root",
          $ref: "child#value",
          annotation: { $id: "child", ...target, x: { $anchor: "value", type: "string" } },
        },
      ]) {
        expectSilentRejection(yield* runHelper(schema, { value: null }));
      }
    }
  }),
);

it.live.each([
  {
    name: "encoded leading slash",
    schema: (target: Schema.Json) => ({ $ref: "#%2Fannotation", annotation: target }),
  },
  {
    name: "encoded nested separator and token",
    schema: (target: Schema.Json) => ({ $ref: "#/%61nnotation%2fx", annotation: { x: target } }),
  },
  {
    name: "encoded pointer escapes",
    schema: (target: Schema.Json) => ({
      $ref: "#/annotation/a%7E1b%7E0c%20d",
      annotation: { "a/b~c d": target },
    }),
  },
  {
    name: "literal percent encoding is not decoded twice",
    schema: (target: Schema.Json) => ({
      $ref: "#/annotation/a%252Fb",
      annotation: { "a%2Fb": target },
    }),
  },
  {
    name: "Unicode token",
    schema: (target: Schema.Json) => ({
      $ref: "#/annotation/%E2%98%83",
      annotation: { "☃": target },
    }),
  },
  {
    name: "encoded named anchor",
    schema: (target: Schema.JsonObject) => ({
      $ref: "#%76alue",
      annotation: { $anchor: "value", ...target },
    }),
  },
  {
    name: "encoded identifier anchor",
    schema: (target: Schema.JsonObject) => ({
      $ref: "#%76alue",
      annotation: { $id: "#value", ...target },
    }),
  },
  {
    name: "reference chain into annotation data",
    schema: (target: Schema.Json) => ({
      $ref: "#%2Fannotation%2F0",
      annotation: [{ $ref: "#%2Fx" }],
      x: target,
    }),
  },
  {
    name: "nested identifier scope",
    schema: (target: Schema.Json) => ({
      $id: "https://example.test/root",
      $ref: "child#%2Fx",
      annotation: { $id: "child", x: target },
    }),
  },
  {
    name: "URN resource scope",
    schema: (target: Schema.Json) => ({
      $id: "urn:example:root",
      $ref: "urn:example:root#/annotation%2Fx",
      annotation: { x: target },
    }),
  },
])("normalizes promoted schema fragments: $name", ({ schema }) =>
  Effect.gen(function* () {
    const safe = schema({ type: "string" });
    const valid = yield* runHelper(safe, "ok");
    expect(valid.code).toBe(0);
    expect(decodeJson(valid.stdout)).toEqual({ valid: true });
    const mismatch = yield* runHelper(safe, null);
    expect(mismatch.code).toBe(0);
    expect(decodeJson(mismatch.stdout)).toEqual({ valid: false });
    expectSilentRejection(yield* runHelper(schema({ type: "string", nullable: true }), null));
  }),
);

it.live("rejects malformed reference encodings without diagnostic leakage", () =>
  Effect.gen(function* () {
    for (const $ref of ["#%", "#/annotation%2", "#%GGanchor", "#/annotation/%C0%AF"]) {
      expectSilentRejection(
        yield* runHelper({ $ref, annotation: { type: "string", nullable: true } }, null),
      );
    }
  }),
);

it.live("conservatively checks matching pointer targets across local resource scopes", () =>
  Effect.gen(function* () {
    expectSilentRejection(
      yield* runHelper(
        {
          $id: "https://example.test/root",
          $ref: "#/x",
          x: { type: "string" },
          annotation: { $id: "other", x: { type: "string", nullable: true } },
        },
        "valid in the root resource",
      ),
    );
  }),
);

it.live("preserves unreferenced literals and validates safe promoted schemas", () =>
  Effect.gen(function* () {
    const literal = {
      nullable: true,
      $schema: "https://example.test/literal-dialect",
      $vocabulary: { "https://example.test/literal-vocabulary": true },
    };
    const validator = yield* makeJsonSchemaValidator();
    yield* validator.validateJsonSchema(
      decodeJson(
        encodeJson({ const: literal, default: literal, examples: [literal], annotation: literal }),
      ),
      literal,
      "not-sent",
    );
    for (const schema of [
      { $ref: "#/x/a~1b~0c%20d", x: { "a/b~c d": { type: "string" } }, literal },
      {
        $id: "https://example.test/root",
        $ref: "child#/x",
        annotation: { $id: "child", x: { type: "string" } },
        literal,
      },
      {
        $id: "https://example.test/root",
        $ref: "child#value",
        annotation: { $id: "child", x: { $anchor: "value", type: "string" } },
        literal,
      },
      {
        $ref: "#/x",
        x: { type: "object", properties: { child: { $ref: "#/x" } } },
        literal,
      },
    ]) {
      const recursive = schema.$ref === "#/x";
      yield* validator.validateJsonSchema(schema, recursive ? { child: {} } : "ok", "not-sent");
      expect(
        yield* validator.validateJsonSchema(schema, null, "not-sent").pipe(Effect.flip),
      ).toMatchObject({ kind: "invalid-input" });
    }
  }),
);

it.live("handles boolean schemas intentionally", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    expect(
      yield* validator.validateJsonSchema(true, { secret: "value" }, "not-sent"),
    ).toBeUndefined();
    expect(
      yield* validator.validateJsonSchema(false, { secret: "value" }, "not-sent").pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input" });
  }),
);

it.effect("rejects malformed and oversized helper replies without exposing their contents", () =>
  Effect.gen(function* () {
    const malformed = yield* makeJsonSchemaValidator({
      processRunner: fixedRunner('{"valid":"secret"}'),
    });
    const malformedResult = yield* malformed
      .validateJsonSchema(true, "secret", "completed")
      .pipe(Effect.result);
    expect(malformedResult).toMatchObject({
      _tag: "Failure",
      failure: { kind: "unavailable", outcome: "completed" },
    });
    expect(encodeUnknown(malformedResult)).not.toContain("secret");

    const oversized = yield* makeJsonSchemaValidator({
      processRunner: fixedRunner("x".repeat(JSON_SCHEMA_VALIDATOR_LIMITS.maximumResponseBytes + 1)),
    });
    expect(
      yield* oversized.validateJsonSchema(true, {}, "completed").pipe(Effect.flip),
    ).toMatchObject({ kind: "output-limit", outcome: "completed" });
  }),
);

it.effect(
  "disables a service after unconfirmed cleanup and releases admission on cancellation",
  () =>
    Effect.gen(function* () {
      const { runner, calls } = countingRunner(undefined, {
        confirmed: false,
        cleanupUnconfirmed: true,
      });
      const uncertain = yield* makeJsonSchemaValidator({ processRunner: runner });
      const first = yield* uncertain.validateJsonSchema(true, {}, "not-sent").pipe(Effect.flip);
      const second = yield* uncertain.validateJsonSchema(true, {}, "not-sent").pipe(Effect.flip);
      expect(first).toMatchObject({ kind: "cleanup" });
      expect(second).toMatchObject({ kind: "unavailable" });
      expect(calls()).toBe(1);

      const started = yield* Deferred.make<void>();
      let activeCalls = 0;
      const cancellable = yield* makeJsonSchemaValidator({
        processRunner: (_input, onCleanup) => {
          activeCalls += 1;
          if (activeCalls > 1)
            return Effect.sync(() => {
              onCleanup(true);
              return processResult('{"valid":true}');
            });
          return Effect.void.pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => onCleanup(true))),
          );
        },
      });
      const pending = yield* cancellable
        .validateJsonSchema(true, {}, "not-sent")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      for (const outcome of ["not-sent", "completed"] as const) {
        expect(
          yield* cancellable.validateJsonSchema(true, {}, outcome).pipe(Effect.flip),
        ).toMatchObject({ kind: "unavailable", outcome });
      }
      yield* Fiber.interrupt(pending);
      expect(activeCalls).toBe(1);
      yield* cancellable.validateJsonSchema(true, {}, "not-sent");
      expect(activeCalls).toBe(2);
    }),
);

it.effect("keeps uncertain helper cleanup disabled across service replacement", () =>
  Effect.gen(function* () {
    const { runner: processRunner, calls } = countingRunner(undefined, {
      confirmed: false,
      cleanupUnconfirmed: true,
    });
    const first = yield* makeJsonSchemaValidator({ processRunner });
    const peer = yield* makeJsonSchemaValidator({ processRunner });
    expect(yield* first.validateJsonSchema(true, {}, "not-sent").pipe(Effect.flip)).toMatchObject({
      kind: "cleanup",
    });
    const replacement = yield* makeJsonSchemaValidator({ processRunner });
    for (const service of [peer, replacement]) {
      expect(
        yield* service.validateJsonSchema(true, {}, "completed").pipe(Effect.flip),
      ).toMatchObject({ kind: "unavailable", outcome: "completed" });
    }
    expect(calls()).toBe(1);
  }),
);

it.live("contains pathological regex and recursive schemas in the helper process", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    expect(
      yield* validator
        .validateJsonSchema(
          { type: "string", pattern: "^(a+)+$" },
          `${"a".repeat(28)}!`,
          "not-sent",
        )
        .pipe(Effect.flip),
    ).toMatchObject({ outcome: "not-sent" });
    expect(
      yield* validator.validateJsonSchema({ $ref: "#" }, {}, "not-sent").pipe(Effect.flip),
    ).toMatchObject({ outcome: "not-sent" });
  }),
);
