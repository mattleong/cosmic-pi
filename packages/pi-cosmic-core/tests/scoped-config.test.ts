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

class TestConfigError {
  readonly _tag = "TestConfigError";
  readonly props: { operation: string; path: string; message: string };
  constructor(props: { operation: string; path: string; message: string }) {
    this.props = props;
  }
}

interface TestFile {
  readonly values: JsonObject;
}

interface TestResolved extends ScopedConfigMetadata {
  readonly project: JsonObject;
  readonly global: JsonObject;
}

const readOnlyOptions: ScopedConfigStoreOptions<TestFile, TestResolved, TestConfigError> = {
  errorFactory: (operation, path) => () =>
    new TestConfigError({ operation, path, message: "test" }),
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
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/config.json": { fromProject: true },
      "/agent/extensions/config.json": { fromGlobal: true },
    });
    const malformedProject = Layer.succeed(JsonDocumentStore, {
      ...memory.service,
      readObject: (path, options) =>
        path.startsWith("/project/")
          ? Effect.fail(new JsonDocumentError({ operation: "decode", path, message: "malformed" }))
          : memory.service.readObject(path, options),
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
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/config.json": { fromProject: true },
      "/agent/extensions/config.json": { fromGlobal: true },
    });
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
});
