import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import type { BoundedProcessResult } from "pi-cosmic-core";
import {
  JSON_SCHEMA_VALIDATOR_LIMITS,
  makeJsonSchemaValidator,
  type JsonSchemaProcessRunner,
} from "../../src/boundary/schema-validator.ts";

const jsonStringSchema = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeSync(jsonStringSchema);
const decodeJson = Schema.decodeUnknownSync(jsonStringSchema);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const processResult = (stdout: string, overrides?: Partial<BoundedProcessResult>) =>
  ({
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    overflowed: false,
    timedOut: false,
    cleanupUnconfirmed: false,
    dispatched: true,
    ...overrides,
  }) satisfies BoundedProcessResult;

const fixedRunner =
  (stdout: string, overrides?: Partial<BoundedProcessResult>): JsonSchemaProcessRunner =>
  (_input, onCleanup) =>
    Effect.sync(() => {
      onCleanup(true);
      return processResult(stdout, overrides);
    });

it.live("validates remote input through the packaged SDK helper", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
    };

    expect(
      yield* validator
        .validateJsonSchema(schema, { name: "Ada", age: 37 }, "not-sent")
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Success" });
    expect(
      yield* validator.validateJsonSchema(schema, { name: 37 }, "not-sent").pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
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
  "counts escaped bytes and rejects excessive depth or node populations before helper admission",
  () =>
    Effect.gen(function* () {
      let dispatched = false;
      const validator = yield* makeJsonSchemaValidator({
        processRunner: (_input, cleanup) =>
          Effect.sync(() => {
            dispatched = true;
            cleanup(true);
            return processResult(encodeJson({ valid: true }));
          }),
      });
      let deep: Schema.Json = null;
      for (let depth = 0; depth <= JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentDepth; depth += 1)
        deep = [deep];
      const inputs: ReadonlyArray<Schema.Json> = [
        "\u0000".repeat(Math.floor(JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes / 6) + 1),
        Array.from({ length: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentNodes }, () => null),
        deep,
      ];
      for (const input of inputs) {
        expect(
          yield* validator.validateJsonSchema(true, input, "completed").pipe(Effect.flip),
        ).toMatchObject({ outcome: "completed", kind: "invalid-input" });
      }
      expect(dispatched).toBe(false);
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
      yield* validator.validateJsonSchema(schema, { count: 0 }, "not-sent").pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-input" } });
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

    let calls = 0;
    const policyValidator = yield* makeJsonSchemaValidator({
      processRunner: (_input, onCleanup) =>
        Effect.sync(() => {
          calls += 1;
          onCleanup(true);
          return processResult('{"valid":true}');
        }),
    });
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "object" } },
      required: ["__proto__"],
    };
    const data = decodeJson('{"__proto__":{"value":null}}');
    const before = encodeJson(data);
    const rejected = yield* policyValidator
      .validateJsonSchema(schema, data, "not-sent")
      .pipe(Effect.result);

    expect(rejected).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(encodeJson(data)).toBe(before);
    expect(calls).toBe(0);
  }),
);

it.effect("rejects remote references and custom constraints before process admission", () =>
  Effect.gen(function* () {
    let calls = 0;
    const runner: JsonSchemaProcessRunner = (_input, onCleanup) =>
      Effect.sync(() => {
        calls += 1;
        onCleanup(true);
        return processResult('{"valid":true}');
      });
    const validator = yield* makeJsonSchemaValidator({ processRunner: runner });

    const remote = yield* validator
      .validateJsonSchema({ $ref: "https://example.test/schema.json" }, {}, "not-sent")
      .pipe(Effect.result);
    const file = yield* validator
      .validateJsonSchema({ $ref: "file:///tmp/schema.json" }, {}, "not-sent")
      .pipe(Effect.result);
    const custom = yield* validator
      .validateJsonSchema({ type: "string", "x-executable": true }, "secret", "not-sent")
      .pipe(Effect.result);
    const customFormat = yield* validator
      .validateJsonSchema({ type: "string", format: "secret-format" }, "secret", "not-sent")
      .pipe(Effect.result);
    const malformed = yield* validator
      .validateJsonSchema({ required: [1] }, {}, "not-sent")
      .pipe(Effect.result);

    expect(remote).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(file).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(custom).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(customFormat).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(malformed).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(calls).toBe(0);
  }),
);

it.live("handles boolean schemas intentionally", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    expect(
      yield* validator.validateJsonSchema(true, { secret: "value" }, "not-sent"),
    ).toBeUndefined();
    expect(
      yield* validator
        .validateJsonSchema(false, { secret: "value" }, "not-sent")
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-input" } });
  }),
);

it.effect("bounds input documents before spawning and preserves output operation certainty", () =>
  Effect.gen(function* () {
    let calls = 0;
    const validator = yield* makeJsonSchemaValidator({
      processRunner: (_input, onCleanup) =>
        Effect.sync(() => {
          calls += 1;
          onCleanup(true);
          return processResult('{"valid":true}');
        }),
    });
    const oversized = "x".repeat(JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes + 1);
    const result = yield* validator
      .validateJsonSchema({ type: "string" }, oversized, "not-sent")
      .pipe(Effect.result);
    let getterAccesses = 0;
    const getterData: Record<string, Schema.Json> = {};
    Object.defineProperty(getterData, "secret", {
      enumerable: true,
      get: () => {
        getterAccesses += 1;
        throw new Error("getter must not run");
      },
    });
    const getterResult = yield* validator
      .validateJsonSchema({ type: "object" }, getterData, "not-sent")
      .pipe(Effect.result);
    const cyclicData: Record<string, Schema.Json> = {};
    cyclicData.self = cyclicData;
    const cycleResult = yield* validator
      .validateJsonSchema({ type: "object" }, cyclicData, "not-sent")
      .pipe(Effect.result);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(getterResult).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(cycleResult).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "not-sent" },
    });
    expect(getterAccesses).toBe(0);
    expect(calls).toBe(0);

    const outputValidator = yield* makeJsonSchemaValidator({
      processRunner: fixedRunner('{"valid":false}'),
    });
    const output = yield* outputValidator
      .validateJsonSchema({ type: "string" }, 1, "completed")
      .pipe(Effect.result);
    expect(output).toMatchObject({
      _tag: "Failure",
      failure: { kind: "protocol", outcome: "completed" },
    });
    const oversizedOutputInput = yield* outputValidator
      .validateJsonSchema({ type: "string" }, oversized, "completed")
      .pipe(Effect.result);
    expect(oversizedOutputInput).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid-input", outcome: "completed" },
    });
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
      failure: { kind: "protocol", outcome: "completed" },
    });
    expect(encodeUnknown(malformedResult)).not.toContain("secret");

    const oversized = yield* makeJsonSchemaValidator({
      processRunner: fixedRunner("x".repeat(JSON_SCHEMA_VALIDATOR_LIMITS.maximumResponseBytes + 1)),
    });
    expect(
      yield* oversized.validateJsonSchema(true, {}, "completed").pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { kind: "output-limit", outcome: "completed" },
    });
  }),
);

it.effect(
  "disables a service after unconfirmed cleanup and releases admission on cancellation",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const uncertain = yield* makeJsonSchemaValidator({
        processRunner: (_input, onCleanup) =>
          Effect.sync(() => {
            calls += 1;
            onCleanup(false);
            return processResult('{"valid":true}', { cleanupUnconfirmed: true });
          }),
      });
      const first = yield* uncertain.validateJsonSchema(true, {}, "not-sent").pipe(Effect.result);
      const second = yield* uncertain.validateJsonSchema(true, {}, "not-sent").pipe(Effect.result);
      expect(first).toMatchObject({ _tag: "Failure", failure: { kind: "cleanup" } });
      expect(second).toMatchObject({ _tag: "Failure", failure: { kind: "unavailable" } });
      expect(calls).toBe(1);

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
      expect(
        yield* cancellable.validateJsonSchema(true, {}, "not-sent").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { kind: "unavailable", outcome: "not-sent" } });
      expect(
        yield* cancellable.validateJsonSchema(true, {}, "completed").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { kind: "unavailable", outcome: "completed" } });
      yield* Fiber.interrupt(pending);
      expect(activeCalls).toBe(1);
      expect(
        yield* cancellable.validateJsonSchema(true, {}, "not-sent").pipe(Effect.result),
      ).toMatchObject({ _tag: "Success" });
      expect(activeCalls).toBe(2);
    }),
);

it.effect("keeps uncertain helper cleanup disabled across service replacement", () =>
  Effect.gen(function* () {
    let calls = 0;
    const processRunner: JsonSchemaProcessRunner = (_input, onCleanup) =>
      Effect.sync(() => {
        calls += 1;
        onCleanup(false);
        return processResult('{"valid":true}', { cleanupUnconfirmed: true });
      });
    const first = yield* makeJsonSchemaValidator({ processRunner });
    const peer = yield* makeJsonSchemaValidator({ processRunner });
    expect(yield* first.validateJsonSchema(true, {}, "not-sent").pipe(Effect.result)).toMatchObject(
      { _tag: "Failure", failure: { kind: "cleanup" } },
    );
    const replacement = yield* makeJsonSchemaValidator({ processRunner });
    for (const service of [peer, replacement]) {
      expect(
        yield* service.validateJsonSchema(true, {}, "completed").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { kind: "unavailable", outcome: "completed" } });
    }
    expect(calls).toBe(1);
  }),
);

it.live("contains pathological regex and recursive schemas in the helper process", () =>
  Effect.gen(function* () {
    const validator = yield* makeJsonSchemaValidator();
    const regex = yield* validator
      .validateJsonSchema({ type: "string", pattern: "^(a+)+$" }, `${"a".repeat(28)}!`, "not-sent")
      .pipe(Effect.result);
    expect(regex).toMatchObject({ _tag: "Failure", failure: { outcome: "not-sent" } });

    const recursive = yield* validator
      .validateJsonSchema({ $ref: "#" }, {}, "not-sent")
      .pipe(Effect.result);
    expect(recursive).toMatchObject({ _tag: "Failure", failure: { outcome: "not-sent" } });
  }),
);
