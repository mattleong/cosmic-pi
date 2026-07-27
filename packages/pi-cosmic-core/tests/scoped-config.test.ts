import { expect, it, layer as testLayer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonObject } from "../src/platform/json-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { decodeTolerantFields } from "../src/config/tolerant-fields.ts";
import { scopedDocumentPaths, selectScopedDocument } from "../src/config/scoped-store.ts";

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
});
