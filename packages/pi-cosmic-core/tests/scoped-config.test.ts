import { expect, it, layer as testLayer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentError } from "../src/platform/errors.ts";
import { JsonDocumentStore, type JsonObject } from "../src/platform/json-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { decodeTolerantFields } from "../src/config/tolerant-fields.ts";
import {
  commitPreferredScope,
  makeScopedConfigStore,
  type ScopedConfigMetadata,
  type ScopedConfigStoreOptions,
} from "../src/config/scoped-config-store.ts";

it("decodes valid siblings and bounds redacted diagnostics", () => {
  const decoded = decodeTolerantFields(
    { enabled: true, interval: "bad", mode: "bad", future: { secret: "retained" } },
    { enabled: Schema.Boolean, interval: Schema.Number, mode: Schema.Literal("known") },
    { path: "usage", maxDiagnostics: 1 },
  );
  expect(decoded.value).toEqual({ enabled: true });
  expect(decoded.diagnostics).toEqual([{ path: "usage.interval", issue: "invalid" }]);
  expect(JSON.stringify(decoded.diagnostics)).not.toContain("bad");
});

it("decodes only own __proto__ fields without prototype mutation", () => {
  const input: JsonObject = { future: true };
  Object.defineProperty(input, "__proto__", {
    value: { enabled: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const ProtoFieldSchema = Schema.Struct({ enabled: Schema.Boolean });
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const fields = Object.create(null) as { readonly __proto__: typeof ProtoFieldSchema };
  Object.defineProperty(fields, "__proto__", {
    value: ProtoFieldSchema,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const decoded = decodeTolerantFields(input, fields);
  expect(Object.hasOwn(decoded.value, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(decoded.value, "__proto__")?.value).toEqual({
    enabled: true,
  });
  expect(Object.getPrototypeOf(decoded.value)).toBe(Object.prototype);

  const missing = decodeTolerantFields({}, fields);
  expect(Object.hasOwn(missing.value, "__proto__")).toBe(false);
});

class TestConfigError extends Schema.TaggedError<TestConfigError>()("TestConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

interface TestFile {
  readonly values: JsonObject;
}

interface TestResolved extends ScopedConfigMetadata {
  readonly project: JsonObject;
  readonly global: JsonObject;
}

const readOnlyOptions: ScopedConfigStoreOptions<TestFile, TestResolved, TestConfigError> = {
  error: TestConfigError,
  label: "Test",
  spanPrefix: "TestConfig",
  projectConfigDirectory: ".pi",
  basename: "config.json",
  decode: (value) => ({ values: value }),
  resolve: (metadata, project, global) => ({
    ...metadata,
    project: project?.values ?? {},
    global: global?.values ?? {},
  }),
};
const readOnlyStore = makeScopedConfigStore(readOnlyOptions);
const testStore = makeScopedConfigStore({ ...readOnlyOptions, defaultDocument: () => ({}) });
const projectDocument = "/project/.pi/extensions/config.json";
const scopedDocuments = {
  [projectDocument]: { fromProject: true },
  "/agent/extensions/config.json": { fromGlobal: true },
};
const changed = (document: JsonObject): JsonObject => ({ ...document, changed: true });

testLayer(Path.layer)("scoped config store", (it) => {
  it.effect("resolves empty scopes without seeding when no default document is supplied", () => {
    const memory = makeInMemoryDocuments();
    return Effect.gen(function* () {
      const resolved = yield* readOnlyStore.resolveConfig("/project", "/agent", true);
      expect(resolved.configPath).toBe(resolved.globalConfigPath);
      expect(resolved.projectConfigExists).toBe(false);
      expect(resolved.globalConfigExists).toBe(false);
      expect(resolved.project).toEqual({});
      expect(resolved.global).toEqual({});
      expect(memory.documents.size).toBe(0);
    }).pipe(Effect.provide(memory.layer));
  });

  it.effect("an existing trusted project wins precedence even when it cannot be read", () => {
    const memory = makeInMemoryDocuments(scopedDocuments);
    const malformedProject = Layer.succeed(JsonDocumentStore, {
      ...memory.service,
      readObject: (path) =>
        path.startsWith("/project/")
          ? Effect.fail(new JsonDocumentError({ operation: "decode", path, message: "malformed" }))
          : memory.service.readObject(path),
    });
    return Effect.gen(function* () {
      expect(yield* readOnlyStore.resolveConfig("/project", "/agent", true)).toEqual({
        configPath: "/project/.pi/extensions/config.json",
        projectConfigPath: "/project/.pi/extensions/config.json",
        globalConfigPath: "/agent/extensions/config.json",
        projectConfigExists: true,
        globalConfigExists: true,
        project: {},
        global: { fromGlobal: true },
      });
    }).pipe(Effect.provide(malformedProject));
  });

  it.effect("omitted trust fails closed without project-document I/O", () => {
    const memory = makeInMemoryDocuments(scopedDocuments);
    return Effect.gen(function* () {
      const resolved = yield* testStore.resolveConfig("/project", "/agent");
      expect(resolved.projectConfigPath).toBe("/project/.pi/extensions/config.json");
      expect(resolved.projectConfigExists).toBe(false);
      expect(resolved.project).toEqual({});
      expect(resolved.global).toEqual({ fromGlobal: true });
      expect(memory.operations.length).toBeGreaterThan(0);
      expect(memory.operations.filter((operation) => operation.includes("/project/"))).toEqual([]);
    }).pipe(Effect.provide(memory.layer));
  });

  it.effect("resolveCommittedConfig updates scope metadata and preserves overlays", () => {
    const memory = makeInMemoryDocuments();
    return Effect.gen(function* () {
      const absent = yield* readOnlyStore.resolveConfig("/project", "/agent", true);
      const projectCommit = testStore.resolveCommittedConfig(
        { ...absent, configPath: absent.projectConfigPath, globalConfigExists: true },
        { fromProject: true },
        { fromGlobal: true },
      );
      expect(projectCommit).toMatchObject({
        configPath: absent.projectConfigPath,
        projectConfigExists: true,
        globalConfigExists: true,
        project: { fromProject: true },
        global: { fromGlobal: true },
      });

      const derivedGlobal = testStore.resolveCommittedConfig(
        absent,
        { fromGlobal: true },
        undefined,
      );
      expect(derivedGlobal).toMatchObject({
        configPath: absent.globalConfigPath,
        projectConfigExists: false,
        globalConfigExists: true,
        project: {},
        global: { fromGlobal: true },
      });
    }).pipe(Effect.provide(memory.layer));
  });

  it.effect("a preferred-scope project commit overlays a readable global document", () => {
    const memory = makeInMemoryDocuments(scopedDocuments);
    return Effect.gen(function* () {
      const current = yield* testStore.resolveConfig("/project", "/agent", true);
      const installed: TestResolved[] = [];
      const next = yield* commitPreferredScope(testStore, current, changed, (resolved) =>
        Effect.sync(() => void installed.push(resolved)),
      );
      expect(next).toMatchObject({
        project: { fromProject: true, changed: true },
        global: { fromGlobal: true },
      });
      expect(installed).toEqual([next]);
      expect(memory.documents.get(projectDocument)).toEqual({ fromProject: true, changed: true });
    }).pipe(Effect.provide(memory.layer));
  });

  it.effect("an unreadable global fallback fails the commit unless it is tolerated", () => {
    const memory = makeInMemoryDocuments(scopedDocuments);
    const unreadableGlobal = Layer.succeed(JsonDocumentStore, {
      ...memory.service,
      readObject: (path) =>
        path.startsWith("/agent/")
          ? Effect.fail(new JsonDocumentError({ operation: "decode", path, message: "malformed" }))
          : memory.service.readObject(path),
    });
    return Effect.gen(function* () {
      const current = yield* testStore.resolveConfig("/project", "/agent", true);
      const failure = yield* Effect.flip(
        commitPreferredScope(testStore, current, changed, () => Effect.void),
      );
      expect(failure).toMatchObject({ _tag: "TestConfigError", operation: "read" });
      expect(memory.documents.get(projectDocument)).toEqual({ fromProject: true });

      const next = yield* commitPreferredScope(testStore, current, changed, () => Effect.void, {
        fallbackWarning: "unreadable",
      });
      expect(next).toMatchObject({ project: { fromProject: true, changed: true }, global: {} });
      expect(memory.documents.get(projectDocument)).toEqual({ fromProject: true, changed: true });
    }).pipe(Effect.provide(unreadableGlobal));
  });
});
