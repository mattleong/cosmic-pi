import { expect, it, layer as testLayer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "../src/platform/json-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { decodeTolerantFields } from "../src/config/tolerant-fields.ts";
import { scopedDocumentPaths, selectScopedDocument } from "../src/config/scoped-store.ts";
import {
  makeScopedConfigStore,
  type ScopedConfigMetadata,
} from "../src/config/scoped-config-store.ts";

it("decodes valid siblings, retains unknown keys, and bounds redacted diagnostics", () => {
  const decoded = decodeTolerantFields(
    { enabled: true, interval: "bad", mode: "bad", future: { secret: "retained" } },
    { enabled: Schema.Boolean, interval: Schema.Number, mode: Schema.Literal("known") },
    { path: "usage", maxDiagnostics: 1 },
  );
  expect(decoded.value).toEqual({ enabled: true });
  expect(decoded.raw.future).toEqual({ secret: "retained" });
  expect(decoded.diagnostics).toEqual([{ path: "usage.interval", issue: "invalid" }]);
  expect(JSON.stringify(decoded.diagnostics)).not.toContain("bad");
});

it("preserves and decodes only own __proto__ fields without prototype mutation", () => {
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
  expect(Object.hasOwn(decoded.raw, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(decoded.raw, "__proto__")?.value).toEqual({
    enabled: true,
  });
  expect(Object.hasOwn(decoded.value, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(decoded.value, "__proto__")?.value).toEqual({
    enabled: true,
  });
  expect(Object.getPrototypeOf(decoded.value)).toBe(Object.prototype);

  const missing = decodeTolerantFields({}, fields);
  expect(Object.hasOwn(missing.value, "__proto__")).toBe(false);
});

testLayer(Path.layer)("scoped document paths", (it) => {
  it.effect("selects the global path when both documents are missing", () => {
    const memory = makeInMemoryDocuments();
    return Effect.gen(function* () {
      const paths = yield* scopedDocumentPaths("/project", "/agent", {
        projectConfigDirectory: ".pi",
        basename: "config.json",
      });
      const selection = yield* selectScopedDocument(paths);
      expect(selection.projectExists).toBe(false);
      expect(selection.globalExists).toBe(false);
      expect(selection.preferred).toBe(paths.global);
    }).pipe(Effect.provideService(JsonDocumentStore, memory.service));
  });

  it.effect("resolves paths and selects project precedence by existence", () => {
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/config.json": { valid: true },
    });
    return Effect.gen(function* () {
      const paths = yield* scopedDocumentPaths("/project", "/agent", {
        projectConfigDirectory: ".pi",
        basename: "config.json",
      });
      expect(paths).toEqual({
        project: "/project/.pi/extensions/config.json",
        global: "/agent/extensions/config.json",
      });
      const selection = yield* selectScopedDocument(paths);
      expect(selection.projectExists).toBe(true);
      expect(selection.globalExists).toBe(false);
      expect(selection.preferred).toBe(paths.project);
    }).pipe(Effect.provideService(JsonDocumentStore, memory.service));
  });

  it.effect("never probes the project document when probeProject is false", () => {
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/config.json": { valid: true },
    });
    const operations: string[] = [];
    const service: JsonDocumentStoreContract = {
      ...memory.service,
      exists: (path) => {
        operations.push(`exists:${path}`);
        return memory.service.exists(path);
      },
    };
    return Effect.gen(function* () {
      const paths = yield* scopedDocumentPaths("/project", "/agent", {
        projectConfigDirectory: ".pi",
        basename: "config.json",
      });
      const selection = yield* selectScopedDocument(paths, { probeProject: false });
      expect(selection.projectExists).toBe(false);
      expect(selection.preferred).toBe(paths.global);
      expect(operations).toEqual([`exists:${paths.global}`]);
    }).pipe(Effect.provideService(JsonDocumentStore, JsonDocumentStore.of(service)));
  });
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

const testStore = makeScopedConfigStore<TestFile, TestResolved, TestConfigError>({
  errorFactory: (operation, path) => () =>
    new TestConfigError({ operation, path, message: "test" }),
  label: "Test",
  spanPrefix: "TestConfig",
  projectConfigDirectory: ".pi",
  basename: "config.json",
  decode: (value) => ({ values: value }),
  defaultDocument: () => ({}),
  resolve: (metadata, project, global) => ({
    ...metadata,
    project: project?.values ?? {},
    global: global?.values ?? {},
  }),
});

testLayer(Path.layer)("scoped config store", (it) => {
  it.effect("omitted trust fails closed without project-document I/O", () => {
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/config.json": { fromProject: true },
      "/agent/extensions/config.json": { fromGlobal: true },
    });
    const operations: string[] = [];
    const record =
      <Arguments extends unknown[], Result>(
        operation: string,
        method: (path: string, ...rest: Arguments) => Result,
      ) =>
      (path: string, ...rest: Arguments): Result => {
        operations.push(`${operation}:${path}`);
        return method(path, ...rest);
      };
    const service: JsonDocumentStoreContract = {
      exists: record("exists", memory.service.exists),
      readObject: record("read", memory.service.readObject),
      writeObject: record("write", memory.service.writeObject),
      modifyObject: (path, modify) => {
        operations.push(`modify:${path}`);
        return memory.service.modifyObject(path, modify);
      },
      updateObject: record("update", memory.service.updateObject),
    };
    return Effect.gen(function* () {
      const resolved = yield* testStore.resolveConfig("/project", "/agent");
      expect(resolved.projectConfigPath).toBe("/project/.pi/extensions/config.json");
      expect(resolved.projectConfigExists).toBe(false);
      expect(resolved.project).toEqual({});
      expect(resolved.global).toEqual({ fromGlobal: true });
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.filter((operation) => operation.includes("/project/"))).toEqual([]);
    }).pipe(Effect.provideService(JsonDocumentStore, JsonDocumentStore.of(service)));
  });

  it.effect("resolveCommittedConfig honors an explicit committed scope with a fallback", () => {
    const memory = makeInMemoryDocuments();
    return Effect.gen(function* () {
      const current = yield* testStore.resolveConfig("/project", "/agent", true);
      // Explicit global commit keeps the project fallback overlay.
      const globalCommit = testStore.resolveCommittedConfig(
        { ...current, configPath: current.projectConfigPath, projectConfigExists: true },
        { fromGlobal: true },
        { fromProject: true },
        "global",
      );
      expect(globalCommit.global).toEqual({ fromGlobal: true });
      expect(globalCommit.project).toEqual({ fromProject: true });

      // Explicit project commit keeps the global fallback overlay.
      const projectCommit = testStore.resolveCommittedConfig(
        { ...current, configPath: current.projectConfigPath, projectConfigExists: true },
        { fromProject: true },
        { fromGlobal: true },
        "project",
      );
      expect(projectCommit.project).toEqual({ fromProject: true });
      expect(projectCommit.global).toEqual({ fromGlobal: true });

      // Without an explicit scope the committed scope derives from the preferred path.
      const derivedGlobal = testStore.resolveCommittedConfig(
        current,
        { fromGlobal: true },
        undefined,
      );
      expect(derivedGlobal.global).toEqual({ fromGlobal: true });
      expect(derivedGlobal.project).toEqual({});
    }).pipe(Effect.provideService(JsonDocumentStore, memory.service));
  });
});
