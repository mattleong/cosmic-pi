import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { provideBuiltLayer, type JsonObject } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import {
  SubagentConfigStore,
  subagentConfigStoreLayer,
  type SubagentProfileRestorePatch,
} from "../src/config/store.ts";
import { effectTest } from "./support/effect-test.ts";

const candidate = {
  host: "local",
  runtime: "pi",
  model: "openai/worker",
  effort: "high",
  context: "fresh",
  writeIntent: "writer",
} as const;
const path = "/agent/pi-subagents.json";
const original: JsonObject = {
  version: 6,
  profileSets: {
    saved: { profiles: { worker: "disabled", scout: "disabled" } },
    other: { profiles: {} },
  },
  nesting: { maxDirectChildren: 3, maxDepth: 2 },
};
const setup = (document: JsonObject = original) => {
  const memory = makeInMemoryDocuments({ [path]: document });
  const layer = subagentConfigStoreLayer.pipe(Layer.provide(Layer.merge(memory.layer, Path.layer)));
  const restore = (patch: Partial<SubagentProfileRestorePatch> = {}) =>
    SubagentConfigStore.use((store) =>
      store.restoreProfileDeclaration("/project", "/agent", {
        scope: "global",
        projectTrusted: false,
        expectedExists: true,
        expectedDocument: document,
        profileSet: "saved",
        profile: "worker",
        sourceVersion: 6,
        ...patch,
      }),
    ).pipe(provideBuiltLayer(layer));
  return { memory, layer, restore };
};

describe("profile declaration visit restore", () => {
  for (const declaration of [
    candidate,
    [candidate],
    {
      ...candidate,
      host: "herdr",
      writeIntent: "read-only",
      openaiFastMode: false,
      closeOnReport: false,
    },
    "disabled",
    undefined,
  ]) {
    effectTest(`preserves declaration ${JSON.stringify(declaration)}`, function* () {
      const { memory, restore } = setup();
      const receipt = yield* restore({ declaration }).pipe(Effect.orDie);
      const profiles: JsonObject = { scout: "disabled" };
      if (declaration !== undefined) profiles.worker = declaration;
      const expected = {
        ...original,
        profileSets: { saved: { profiles }, other: { profiles: {} } },
      };
      expect(receipt).toEqual(expected);
      expect(memory.documents.get(path)).toEqual(expected);
      receipt.version = 99;
      expect(memory.documents.get(path)?.version).toBe(6);
    });
  }

  for (const patch of [
    { declaration: [] },
    { declaration: { ...candidate, unknown: true } },
    { declaration: { ...candidate, openaiFastMode: "false" } },
    { declaration: "broken" },
    { sourceVersion: 3 },
    { profileSet: "missing" },
    { scope: "project" as const, projectTrusted: false },
    { expectedDocument: { version: 6 } },
  ]) {
    effectTest(`rejects invalid or unauthorized restore ${JSON.stringify(patch)}`, function* () {
      const { memory, restore } = setup();
      const result = yield* restore(patch).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(memory.documents.get(path)).toEqual(original);
    });
  }

  effectTest("rejects an external edit inside the document transaction", function* () {
    const { memory, restore } = setup();
    memory.injectBeforeNextUpdate((current) => ({ ...current, defaultProfileSet: "other" }));
    expect((yield* restore({ declaration: candidate }).pipe(Effect.result))._tag).toBe("Failure");
    expect(memory.documents.get(path)).toEqual(original);
  });

  for (const version of [4, 5]) {
    effectTest(`migrates valid version ${version} restoration`, function* () {
      const legacy: JsonObject = { version, profiles: { worker: "disabled", scout: "disabled" } };
      const { restore, memory } = setup(legacy);
      const receipt = yield* restore({
        profileSet: "default",
        sourceVersion: version,
        declaration: [{ ...candidate, fastMode: true }],
      }).pipe(Effect.orDie);
      expect(receipt).toEqual({
        version: 6,
        defaultProfileSet: "default",
        profileSets: {
          default: {
            profiles: { scout: "disabled", worker: [{ ...candidate, openaiFastMode: true }] },
          },
        },
      });
      expect(memory.documents.get(path)).toEqual(receipt);
    });
  }

  effectTest("rejects absence restoration after the target document is deleted", function* () {
    const { restore, memory } = setup();
    memory.documents.delete(path);
    expect(
      (yield* restore({ expectedExists: false, expectedDocument: undefined }).pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    expect(memory.documents.has(path)).toBe(false);
  });

  effectTest(
    "rejects malformed legacy documents rather than clearing invalid routes",
    function* () {
      const { restore, memory } = setup({ version: 5, profiles: { worker: "broken" } });
      expect(
        (yield* restore({ profileSet: "default", sourceVersion: 5 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(memory.documents.get(path)).toEqual({ version: 5, profiles: { worker: "broken" } });
    },
  );

  effectTest("rejects accessor declarations without evaluating them", function* () {
    let reads = 0;
    const declaration = {
      ...candidate,
      get closeOnReport() {
        reads += 1;
        return true;
      },
    };
    const { restore } = setup();
    expect((yield* restore({ declaration }).pipe(Effect.result))._tag).toBe("Failure");
    expect(reads).toBe(0);
  });

  effectTest("returns the committed patch rather than a later document read", function* () {
    const { memory, layer } = setup();
    const receipt = yield* SubagentConfigStore.use((store) =>
      store.patchProfileWithReceipt("/project", "/agent", {
        scope: "global",
        projectTrusted: false,
        expectedExists: true,
        expectedDocument: original,
        profileSet: "saved",
        profile: "worker",
        route: [candidate],
      }),
    ).pipe(provideBuiltLayer(layer), Effect.orDie);
    expect(receipt).toEqual(memory.documents.get(path));
    const committed = structuredClone(receipt);
    memory.documents.set(path, { ...original, defaultProfileSet: "other" });
    expect(receipt).toEqual(committed);
    expect(receipt).not.toEqual(original);
  });
});
