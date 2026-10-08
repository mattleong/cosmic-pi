// The store runs on core's in-memory JSON documents; core tests the live atomic file adapter.
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  JsonDocumentError,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonObject,
} from "pi-cosmic-core";
import {
  makeInMemoryDocuments,
  opaqueFixture,
  type InMemoryDocuments,
} from "pi-cosmic-core/testing";
import {
  SubagentConfigStore,
  subagentConfigStoreLayer,
  type SubagentConfigScope,
  type SubagentConfigStoreError,
  type SubagentProfileRestorePatch,
} from "../src/config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";

const CWD = "/repo";
const AGENT = "/agent";
const GLOBAL = `${AGENT}/pi-subagents.json`;
const PROJECT = `${CWD}/${CONFIG_DIR_NAME}/pi-subagents.json`;
const pathOf = (scope: SubagentConfigScope) => (scope === "global" ? GLOBAL : PROJECT);

const storeLayer = (documents: Layer.Layer<JsonDocumentStore>) =>
  subagentConfigStoreLayer.pipe(Layer.provide(Layer.merge(documents, Path.layer)));

const setup = (documents: Readonly<Record<string, JsonObject>> = {}) => {
  const memory = makeInMemoryDocuments(documents);
  return SubagentConfigStore.use((store) => Effect.succeed({ memory, store })).pipe(
    provideBuiltLayer(storeLayer(memory.layer)),
  );
};

/** A trusted write expecting exactly `document`, or no file when it is undefined. */
const at = (scope: SubagentConfigScope, document?: JsonObject) => ({
  scope,
  projectTrusted: true,
  expectedExists: document !== undefined,
  ...(document !== undefined && { expectedDocument: document }),
});

/** A version-6 document whose selected `default` set declares `profiles`. */
const v6 = (profiles: JsonObject, rest: JsonObject = {}): JsonObject => ({
  version: 6,
  defaultProfileSet: "default",
  profileSets: { default: { profiles } },
  ...rest,
});

const rejects = <A>(
  attempt: Effect.Effect<A, SubagentConfigStoreError>,
  operation: string,
  path: string,
  message?: string,
) =>
  Effect.flip(attempt).pipe(
    Effect.map((error) =>
      expect(error).toMatchObject({
        operation,
        path,
        ...(message !== undefined && { message: expect.stringContaining(message) }),
      }),
    ),
  );

const writes = (memory: InMemoryDocuments) =>
  memory.operations.filter((operation) => /^(modify|write):/u.test(operation));

describe("SubagentConfigStore activation", () => {
  it.effect(
    "fails mixed retired routes closed in every version and scope without load writes",
    () =>
      Effect.gen(function* () {
        const local = declaredCandidate("openai/local");
        for (const version of [4, 5, 6])
          for (const scope of ["global", "project"] as const)
            for (const runtime of ["pi", "claude", "codex"])
              for (const remoteFirst of [true, false]) {
                const remote = declaredCandidate(runtime === "pi" ? "openai/remote" : "native", {
                  host: "herdr",
                  runtime,
                });
                const profiles = {
                  worker: remoteFirst ? [remote, local] : [local, remote],
                  scout: local,
                };
                const raw = version === 6 ? v6(profiles) : { version, profiles };
                const { memory, store } = yield* setup(
                  scope === "global"
                    ? { [GLOBAL]: raw }
                    : { [GLOBAL]: v6({ worker: local }), [PROJECT]: raw },
                );
                const config = yield* store.load(CWD, AGENT, scope === "project");
                expect(config.profiles.worker.candidates).toEqual([]);
                expect(config.profileSources.worker).toBe(`${scope}-invalid`);
                expect(config.profiles.scout.candidates[0]?.model).toBe("openai/local");
                expect(config.profileSources.scout).toBe(scope);
                expect(writes(memory)).toEqual([]);
              }
      }),
  );

  it.effect("loads v4 routes with v6 nesting defaults and project inheritance", () =>
    Effect.gen(function* () {
      const worker = declaredCandidate("openai/worker", { writeIntent: "writer" });
      const { store } = yield* setup({
        [GLOBAL]: { version: 4, profiles: { worker } },
        [PROJECT]: { version: 4 },
      });
      const config = yield* store.load(CWD, AGENT, true);
      expect(config.profiles.worker).toEqual({ candidates: [worker] });
      expect(config.profileSources.worker).toBe("global");
      expect(config.fallbackProfile).toBe("generalist");
      expect(config.nesting).toEqual({ maxDirectChildren: 12, maxDepth: 3 });
    }),
  );

  it.effect("rejects unsupported or malformed documents at activation", () =>
    Effect.gen(function* () {
      for (const document of [
        { version: 1 },
        { version: 2 },
        {},
        { version: "4" },
        { version: 4, defaultProfile: "generalist" },
        { version: 4, customFutureField: true },
        { version: 4, nesting: { maxDirectChildren: 32, maxDepth: 8 } },
        { version: 5, nesting: { maxDirectChildren: 0, maxDepth: 3 } },
        { version: 5, nesting: { maxDirectChildren: 33, maxDepth: 3 } },
        { version: 5, nesting: { maxDirectChildren: 12, maxDepth: -1 } },
        { version: 5, nesting: { maxDirectChildren: 12, maxDepth: 9 } },
        { version: 5, nesting: { maxDirectChildren: 12.5, maxDepth: 3 } },
        { version: 6, writerWorkspaceMode: "invalid" },
        { version: 6, ultracode: "true" },
        { version: 6, ultracode: null },
        { version: 6, automaticProfileRouting: null, unknownFeature: true },
        { version: 5, ultracode: true },
        { version: 4, automaticProfileRouting: true },
        { version: 5, automaticProfileRouting: false },
      ]) {
        const { store } = yield* setup({ [GLOBAL]: document });
        yield* rejects(store.load(CWD, AGENT, true), "activate", GLOBAL);
      }
      const { store } = yield* setup({
        [GLOBAL]: { version: 3, denied: [{ backend: "pi", model: "legacy" }] },
      });
      yield* rejects(store.load(CWD, AGENT, true), "activate", GLOBAL, "must declare version 4");
    }),
  );

  it.effect("never reads an untrusted project, so its invalid values cannot block activation", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({
        [GLOBAL]: { version: 6, ultracode: true },
        [PROJECT]: { version: 6, ultracode: "on" },
      });
      expect((yield* store.load(CWD, AGENT, false)).ultracode).toBe(true);
      expect(memory.operations).not.toContain(`read:${PROJECT}`);
      yield* rejects(store.load(CWD, AGENT, true), "activate", PROJECT);
    }),
  );

  it.effect("fails activation closed on an unreadable document", () =>
    Effect.gen(function* () {
      const unreadable = Layer.succeed(
        JsonDocumentStore,
        opaqueFixture({
          readObject: (path: string) =>
            Effect.fail(new JsonDocumentError({ operation: "read", path, message: "Bad JSON." })),
        }),
      );
      yield* rejects(
        SubagentConfigStore.use((store) => store.load(CWD, AGENT, true)).pipe(
          provideBuiltLayer(storeLayer(unreadable)),
        ),
        "read",
        GLOBAL,
      );
    }),
  );

  it.effect("keeps invalid defaults and unknown aliases loadable for fail-closed repair", () =>
    Effect.gen(function* () {
      let { store } = yield* setup({
        [GLOBAL]: {
          version: 6,
          defaultProfileSet: "missing",
          profileSets: { valid: { profiles: {} } },
        },
      });
      let config = yield* store.load(CWD, AGENT, true);
      expect(config.currentProfileSet).toEqual({ scope: "global", name: "missing", invalid: true });
      expect(PROFILE_IDS.map((id) => config.profileSources[id])).toEqual(
        PROFILE_IDS.map(() => "global-invalid"),
      );
      expect(config.diagnostics).toContain("global.defaultProfileSet");

      ({ store } = yield* setup({ [GLOBAL]: { version: 4, profiles: { delegate: "disabled" } } }));
      config = yield* store.load(CWD, AGENT, true);
      expect(config.profileSources.generalist).toBe("builtin");
      expect(config.diagnostics).toContain("global.profiles.<unknown>");
    }),
  );

  it.effect("applies strict v5 nesting precedence", () =>
    Effect.gen(function* () {
      const { store } = yield* setup({
        [GLOBAL]: { version: 5, nesting: { maxDirectChildren: 20, maxDepth: 6 } },
        [PROJECT]: { version: 5, nesting: { maxDirectChildren: 4, maxDepth: 2 } },
      });
      expect((yield* store.load(CWD, AGENT, true)).nesting).toEqual({
        maxDirectChildren: 4,
        maxDepth: 2,
      });
      expect((yield* store.load(CWD, AGENT, false)).nesting).toEqual({
        maxDirectChildren: 20,
        maxDepth: 6,
      });
    }),
  );
});

describe("SubagentConfigStore profile writes", () => {
  it.effect("persists typed local patches with undefined optional fields", () =>
    Effect.gen(function* () {
      const candidate = {
        ...profileCandidate("openai/local"),
        openaiFastMode: undefined,
        closeOnReport: undefined,
      };
      const { closeOnReport: _omitted, ...persisted } = declaredCandidate("openai/local");
      for (const asArray of [false, true]) {
        const document = v6({});
        const { memory, store } = yield* setup({ [GLOBAL]: document });
        yield* store.patchProfile(CWD, AGENT, {
          ...at("global", document),
          profileSet: "default",
          profile: "worker",
          route: asArray ? [candidate] : candidate,
        });
        expect(memory.documents.get(GLOBAL)).toEqual(
          v6({ worker: asArray ? [persisted] : persisted }),
        );
        const loaded = yield* store.load(CWD, AGENT, false);
        expect(loaded.profileSources.worker).toBe("global");
        expect(loaded.profiles.worker.candidates[0]).toMatchObject({
          host: "local",
          model: "openai/local",
          closeOnReport: true,
        });
      }
    }),
  );

  it.effect("rejects direct invalid typed patches without changing the raw document", () =>
    Effect.gen(function* () {
      const local = declaredCandidate("openai/local");
      const document = v6({ worker: local });
      const { memory, store } = yield* setup({ [GLOBAL]: document });
      let reads = 0;
      const accessor = Object.defineProperty({ ...local }, "host", {
        enumerable: true,
        get: () => {
          reads += 1;
          return "herdr";
        },
      });
      const accessorArray = Object.defineProperty([local], "0", {
        enumerable: true,
        get: () => {
          reads += 1;
          return local;
        },
      });
      for (const route of [
        { ...local, host: "herdr" },
        { ...local, closeOnReport: false },
        { ...local, model: undefined },
        { ...local, unknown: undefined },
        [local, { ...local, host: "herdr" }],
        accessor,
        accessorArray,
      ]) {
        // SAFETY: The public typed store boundary is intentionally supplied unknown invalid input.
        const invalid = route as never;
        yield* rejects(
          store.patchProfile(CWD, AGENT, {
            ...at("global", document),
            profileSet: "default",
            profile: "worker",
            route: invalid,
          }),
          "update",
          GLOBAL,
        );
        expect(memory.documents.get(GLOBAL)).toEqual(document);
      }
      expect(reads).toBe(0);
    }),
  );

  it.effect(
    "repairs only the targeted v6 declaration and rejects selecting the still-invalid set",
    () =>
      Effect.gen(function* () {
        const remote = declaredCandidate("openai/remote", { host: "herdr" });
        const initial = {
          version: 6,
          profileSets: {
            repair: {
              profiles: {
                worker: remote,
                reviewer: [remote, declaredCandidate("openai/local")],
                scout: { not: "a candidate" },
              },
            },
            other: { profiles: { planner: remote } },
          },
        };
        const { memory, store } = yield* setup({ [GLOBAL]: initial });
        const select = (document: JsonObject) =>
          store.patchDefaultProfileSet(CWD, AGENT, {
            ...at("global", document),
            defaultProfileSet: "repair",
          });
        yield* rejects(select(initial), "update", GLOBAL);
        const local = profileCandidate("openai/repaired");
        yield* store.patchProfile(CWD, AGENT, {
          ...at("global", initial),
          profileSet: "repair",
          profile: "worker",
          route: local,
        });
        const { openaiFastMode: _fast, ...persistedLocal } = local;
        const expected = {
          ...initial,
          profileSets: {
            ...initial.profileSets,
            repair: {
              profiles: { ...initial.profileSets.repair.profiles, worker: persistedLocal },
            },
          },
        };
        expect(memory.documents.get(GLOBAL)).toEqual(expected);
        yield* rejects(select(expected), "update", GLOBAL);
        expect(memory.documents.get(GLOBAL)).toEqual(expected);
      }),
  );

  it.effect("atomically patches one legacy profile while preserving unrelated routes", () =>
    Effect.gen(function* () {
      const reviewer = [
        declaredCandidate("openai/first", { effort: "medium" }),
        declaredCandidate("openai/second"),
      ];
      const initial = {
        version: 4,
        profiles: { scout: declaredCandidate("parent", { effort: "default" }), reviewer },
      };
      const { memory, store } = yield* setup({ [GLOBAL]: initial });
      const scout = profileCandidate("openai-codex/gpt-5.6-sol", {
        effort: "low",
        openaiFastMode: true,
      });
      yield* store.patchProfile(CWD, AGENT, {
        ...at("global", initial),
        profileSet: "default",
        profile: "scout",
        route: scout,
      });
      expect(memory.documents.get(GLOBAL)).toEqual({
        ...v6({ reviewer }),
        profileSets: { default: { profiles: { scout, reviewer } } },
      });
      const refreshed = yield* store.inspect(CWD, AGENT, true);
      expect(refreshed.config.profiles.scout.candidates[0]?.openaiFastMode).toBe(true);
    }),
  );

  it.effect("never migrates legacy remote routes until an explicit complete repair", () =>
    Effect.gen(function* () {
      const remote = declaredCandidate("openai/remote", { host: "herdr" });
      for (const version of [4, 5]) {
        const initial = { version, profiles: { worker: remote, reviewer: remote } };
        const { memory, store } = yield* setup({ [GLOBAL]: initial });
        yield* rejects(
          store.patchNesting(CWD, AGENT, {
            ...at("global", initial),
            nesting: { maxDirectChildren: 4, maxDepth: 2 },
          }),
          "update",
          GLOBAL,
        );
        const disableWorker = (document: JsonObject) =>
          store.patchProfile(CWD, AGENT, {
            ...at("global", document),
            profileSet: "default",
            profile: "worker",
            route: "disabled",
          });
        yield* rejects(disableWorker(initial), "update", GLOBAL);
        expect(memory.documents.get(GLOBAL)).toEqual(initial);
        const repairable = { version, profiles: { worker: remote } };
        memory.documents.set(GLOBAL, repairable);
        yield* disableWorker(repairable);
        expect(memory.documents.get(GLOBAL)).toEqual(v6({ worker: "disabled" }));
      }
    }),
  );

  it.effect("migrates valid legacy routes and refuses malformed legacy data", () =>
    Effect.gen(function* () {
      const legacy = {
        version: 5,
        profiles: { generalist: declaredCandidate("openai-codex/gpt-5.6-sol", { fastMode: true }) },
        nesting: { maxDirectChildren: 10, maxDepth: 4 },
      };
      const { memory, store } = yield* setup({ [GLOBAL]: legacy });
      yield* store.patchNesting(CWD, AGENT, { ...at("global", legacy), nesting: legacy.nesting });
      const generalist = { ...declaredCandidate("openai-codex/gpt-5.6-sol"), openaiFastMode: true };
      expect(memory.documents.get(GLOBAL)).toEqual(v6({ generalist }, { nesting: legacy.nesting }));

      for (const invalid of [
        { version: 4, profiles: [] },
        { version: 4, profiles: { scout: declaredCandidate("bare") } },
      ]) {
        memory.documents.set(GLOBAL, invalid);
        yield* rejects(
          store.patchProfile(CWD, AGENT, {
            ...at("global", invalid),
            profileSet: "default",
            profile: "worker",
            route: "disabled",
          }),
          "update",
          GLOBAL,
        );
        expect(memory.documents.get(GLOBAL)).toEqual(invalid);
      }
    }),
  );

  it.effect("clears a legacy route, keeping an existing migrated default set for undo", () =>
    Effect.gen(function* () {
      const worker = declaredCandidate("openai/worker");
      // Without a root `profiles` container there is no default set to keep.
      let { memory, store } = yield* setup({ [GLOBAL]: { version: 4 } });
      const clearWorker = (document: JsonObject) =>
        store.patchProfile(CWD, AGENT, {
          ...at("global", document),
          profileSet: "default",
          profile: "worker",
        });
      expect(yield* clearWorker({ version: 4 })).toEqual({ version: 6 });

      const legacy = { version: 4, profiles: { worker } };
      ({ memory, store } = yield* setup({ [GLOBAL]: legacy }));
      const cleared = yield* clearWorker(legacy);
      expect(cleared).toEqual(v6({}));
      expect((yield* store.load(CWD, AGENT, false)).currentProfileSet).toEqual({
        scope: "global",
        name: "default",
      });
      yield* store.restoreProfileDeclaration(CWD, AGENT, {
        ...at("global", cleared),
        profileSet: "default",
        profile: "worker",
        declaration: worker,
        sourceVersion: 4,
      });
      expect(memory.documents.get(GLOBAL)).toEqual(v6({ worker }));
    }),
  );

  it.effect("removes inherited routes and rejects untrusted project writes", () =>
    Effect.gen(function* () {
      const initial = {
        version: 4,
        profiles: {
          worker: declaredCandidate("parent", { effort: "default" }),
          reviewer: "disabled",
        },
      };
      const { memory, store } = yield* setup({ [PROJECT]: initial });
      const removal = {
        ...at("project", initial),
        profileSet: "default",
        profile: "worker",
      } as const;
      yield* rejects(
        store.patchProfile(CWD, AGENT, { ...removal, projectTrusted: false }),
        "update",
        PROJECT,
        "trusted project",
      );
      expect(memory.documents.get(PROJECT)).toEqual(initial);
      yield* store.patchProfile(CWD, AGENT, removal);
      expect(memory.documents.get(PROJECT)).toEqual(v6({ reviewer: "disabled" }));
    }),
  );

  it.effect("detects external edits instead of clobbering them", () =>
    Effect.gen(function* () {
      const scoutDocument = (effort: string) => ({
        version: 4,
        profiles: { scout: declaredCandidate("parent", { effort }) },
      });
      const { memory, store } = yield* setup({ [GLOBAL]: scoutDocument("high") });
      const stale = at("global", scoutDocument("low"));
      for (const write of [
        store.patchProfile(CWD, AGENT, {
          ...stale,
          profileSet: "default",
          profile: "worker",
          route: "disabled",
        }),
        store.patchNesting(CWD, AGENT, {
          ...stale,
          nesting: { maxDirectChildren: 8, maxDepth: 4 },
        }),
        store.patchProfile(CWD, AGENT, { ...stale, profileSet: "default", profile: "worker" }),
        store.patchWriterWorkspace(CWD, AGENT, { ...stale, writerWorkspaceMode: "worktree" }),
      ])
        yield* rejects(write, "update", GLOBAL, "changed on disk");
      expect(memory.documents.get(GLOBAL)).toEqual(scoutDocument("high"));
    }),
  );

  it.effect("treats removal patches with no backing file or key as true no-ops", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup();
      for (const scope of ["project", "global"] as const) {
        yield* store.patchProfile(CWD, AGENT, {
          ...at(scope),
          profileSet: "default",
          profile: "worker",
        });
        yield* store.patchNesting(CWD, AGENT, at(scope));
        yield* store.patchDefaultProfileSet(CWD, AGENT, at(scope));
        yield* store.patchWriterWorkspace(CWD, AGENT, at(scope));
        yield* store.deleteProfileSet(CWD, AGENT, { ...at(scope), profileSet: "missing" });
        yield* store.patchFeatureToggle(CWD, AGENT, { ...at(scope), toggle: "ultracode" });
        expect(memory.documents.has(pathOf(scope))).toBe(false);
        // A missing file never skips validation of an invalid target.
        yield* rejects(
          store.deleteProfileSet(CWD, AGENT, { ...at(scope), profileSet: "bad/name" }),
          "update",
          pathOf(scope),
          "Invalid profile-set name",
        );
        yield* rejects(
          store.patchProfile(CWD, AGENT, {
            ...at(scope),
            profileSet: "bad/name",
            profile: "worker",
          }),
          "update",
          pathOf(scope),
          "Invalid profile target",
        );
      }
      // Only a change from the version-6 default creates the document.
      yield* store.patchFeatureToggle(CWD, AGENT, {
        ...at("global"),
        toggle: "ultracode",
        enabled: true,
      });
      expect(memory.documents.get(GLOBAL)).toEqual({ version: 6, ultracode: true });
      yield* rejects(
        store.patchProfile(CWD, AGENT, {
          ...at("global"),
          profileSet: "default",
          profile: "worker",
        }),
        "update",
        GLOBAL,
      );
    }),
  );

  it.effect(
    "conflicts when an expected-missing document is externally created as an empty object",
    () =>
      Effect.gen(function* () {
        const { memory, store } = yield* setup({ [GLOBAL]: {} });
        yield* rejects(
          store.createProfileSetFromSnapshot(CWD, AGENT, {
            ...at("global"),
            profileSet: "new-set",
            profiles: BUILTIN_PROFILE_ROUTES,
          }),
          "update",
          GLOBAL,
        );
        yield* rejects(
          store.patchProfile(CWD, AGENT, {
            ...at("global"),
            profileSet: "default",
            profile: "worker",
          }),
          "update",
          GLOBAL,
        );
        expect(memory.documents.get(GLOBAL)).toEqual({});
      }),
  );
});

describe("SubagentConfigStore profile sets", () => {
  it.effect("keeps structurally invalid sets repairable but refuses to select them", () =>
    Effect.gen(function* () {
      const document = {
        version: 6,
        profileSets: { broken: { profiles: {}, extra: true }, valid: { profiles: {} } },
      };
      const { store } = yield* setup({ [GLOBAL]: document });
      yield* rejects(
        store.patchDefaultProfileSet(CWD, AGENT, {
          ...at("global", document),
          defaultProfileSet: "broken",
        }),
        "update",
        GLOBAL,
        "structurally invalid",
      );
      yield* store.deleteProfileSet(CWD, AGENT, {
        ...at("global", document),
        profileSet: "broken",
      });
      const inspection = yield* store.inspect(CWD, AGENT, true);
      expect(inspection.global.invalidProfileSets).toEqual([]);
      expect(inspection.global.file.profileSets).toHaveProperty("valid");
    }),
  );

  it.effect("refuses to select a set containing an invalid profile route", () =>
    Effect.gen(function* () {
      const document = {
        version: 6,
        profileSets: { broken: { profiles: { worker: null } }, valid: { profiles: {} } },
      };
      const { memory, store } = yield* setup({ [GLOBAL]: document });
      const inspection = yield* store.inspect(CWD, AGENT, true);
      expect(inspection.global.invalidProfileSetRoutes.broken).toEqual(["worker"]);
      yield* rejects(
        store.patchDefaultProfileSet(CWD, AGENT, {
          ...at("global", document),
          defaultProfileSet: "broken",
        }),
        "update",
        GLOBAL,
        "invalid profile route",
      );
      expect(memory.documents.get(GLOBAL)).toEqual(document);
    }),
  );

  it.effect("creates, copies, renames, selects, and safely deletes scope-local sets", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup();
      // Every write is guarded by the most recently committed document.
      const current = () => at("global", memory.documents.get(GLOBAL));
      yield* store.createProfileSetFromSnapshot(CWD, AGENT, {
        ...current(),
        profileSet: "alpha",
        profiles: BUILTIN_PROFILE_ROUTES,
      });
      const generalist = profileCandidate("openai-codex/gpt-5.6-sol", { openaiFastMode: true });
      yield* store.patchProfile(CWD, AGENT, {
        ...current(),
        profileSet: "alpha",
        profile: "generalist",
        route: generalist,
      });
      yield* store.copyProfileSet(CWD, AGENT, {
        ...current(),
        sourceProfileSet: "alpha",
        profileSet: "copy",
      });
      yield* store.patchDefaultProfileSet(CWD, AGENT, { ...current(), defaultProfileSet: "alpha" });
      yield* store.renameProfileSet(CWD, AGENT, {
        ...current(),
        profileSet: "alpha",
        nextProfileSet: "main",
      });
      yield* rejects(
        store.deleteProfileSet(CWD, AGENT, { ...current(), profileSet: "main" }),
        "update",
        GLOBAL,
        "Choose another default",
      );
      yield* store.deleteProfileSet(CWD, AGENT, { ...current(), profileSet: "copy" });
      expect(memory.documents.get(GLOBAL)).toEqual({
        version: 6,
        defaultProfileSet: "main",
        profileSets: { main: { profiles: expect.objectContaining({ generalist }) } },
      });
    }),
  );

  it.effect("atomically saves all seven session routes as a non-default set", () =>
    Effect.gen(function* () {
      const document = {
        version: 6,
        defaultProfileSet: "active",
        profileSets: { active: { profiles: {} } },
      };
      const { memory, store } = yield* setup({ [GLOBAL]: document });
      const { config } = yield* store.inspect(CWD, AGENT, true);
      const saveSnapshot = (profileSet: string) =>
        store.createProfileSetFromSnapshot(CWD, AGENT, {
          ...at("global", document),
          profileSet,
          profiles: {
            ...config.profiles,
            reviewer: { candidates: [profileCandidate("openai/snapshot-reviewer")] },
            worker: { candidates: [] },
          },
        });
      yield* saveSnapshot("session-copy");
      const saved = memory.documents.get(GLOBAL);
      expect(saved).toEqual({
        ...document,
        profileSets: {
          ...document.profileSets,
          "session-copy": {
            profiles: {
              ...Object.fromEntries(PROFILE_IDS.map((id) => [id, expect.anything()])),
              worker: "disabled",
              reviewer: [expect.objectContaining({ model: "openai/snapshot-reviewer" })],
            },
          },
        },
      });
      yield* rejects(saveSnapshot("stale-copy"), "update", GLOBAL);
      expect(memory.documents.get(GLOBAL)).toEqual(saved);
    }),
  );

  it.effect("rejects snapshot candidate accessors and custom iterators without invoking them", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup();
      const { config } = yield* store.inspect(CWD, AGENT, true);
      const reviewer = config.profiles.reviewer.candidates[0];
      let accessorReads = 0;
      let iteratorCalls = 0;
      const throwingGetter = {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error("accessor must not run");
        },
      };
      const customIterator = Object.defineProperty([reviewer], Symbol.iterator, {
        value: () => {
          iteratorCalls += 1;
          throw new Error("custom iterator must not run");
        },
      });
      for (const [profileSet, route] of [
        ["route-accessor", Object.defineProperty({}, "candidates", throwingGetter)],
        ["element-accessor", { candidates: Object.defineProperty([], "0", throwingGetter) }],
        [
          "candidate-accessor",
          { candidates: [Object.defineProperty({ ...reviewer }, "model", throwingGetter)] },
        ],
        ["custom-iterator", { candidates: customIterator }],
      ] as const) {
        // SAFETY: This test deliberately violates the typed route contract to exercise hostile input containment.
        const profiles = { ...config.profiles, reviewer: route } as never;
        yield* rejects(
          store.createProfileSetFromSnapshot(CWD, AGENT, { ...at("global"), profileSet, profiles }),
          "update",
          GLOBAL,
        );
      }
      expect([accessorReads, iteratorCalls]).toEqual([0, 0]);
      expect(memory.documents.has(GLOBAL)).toBe(false);
    }),
  );
});

describe("SubagentConfigStore preferences", () => {
  it.effect(
    "saves and clears a workspace preference without changing profile sets or nesting",
    () =>
      Effect.gen(function* () {
        const original = {
          version: 6,
          profileSets: { saved: { profiles: {} } },
          defaultProfileSet: "saved",
          nesting: { maxDirectChildren: 4, maxDepth: 2 },
        };
        const { memory, store } = yield* setup({ [GLOBAL]: original });
        yield* store.patchWriterWorkspace(CWD, AGENT, {
          ...at("global", original),
          writerWorkspaceMode: "shared-checkout",
        });
        const saved = { ...original, writerWorkspaceMode: "shared-checkout" };
        expect(memory.documents.get(GLOBAL)).toEqual(saved);
        expect((yield* store.load(CWD, AGENT, false)).writerWorkspaceMode).toBe("shared-checkout");
        yield* rejects(
          store.patchWriterWorkspace(CWD, AGENT, {
            ...at("global", saved),
            // SAFETY: Deliberately exercises an untyped caller with an unknown mode.
            writerWorkspaceMode: "invalid" as never,
          }),
          "update",
          GLOBAL,
        );
        yield* store.patchWriterWorkspace(CWD, AGENT, at("global", saved));
        expect(memory.documents.get(GLOBAL)).toEqual(original);
        expect((yield* store.load(CWD, AGENT, false)).writerWorkspaceMode).toBe("shared-checkout");
      }),
  );

  it.effect("saves and clears one switch and nesting while preserving every other field", () =>
    Effect.gen(function* () {
      const original = {
        version: 6,
        defaultProfileSet: "saved",
        profileSets: { saved: { profiles: { worker: "disabled" } } },
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
        writerWorkspaceMode: "worktree",
        automaticProfileRouting: { retired: ["preserve", null, false] },
      };
      const { memory, store } = yield* setup({ [PROJECT]: original });
      yield* store.patchFeatureToggle(CWD, AGENT, {
        ...at("project", original),
        toggle: "ultracode",
        enabled: true,
      });
      const saved = { ...original, ultracode: true };
      expect(memory.documents.get(PROJECT)).toEqual(saved);
      expect((yield* store.load(CWD, AGENT, true)).ultracode).toBe(true);

      yield* store.patchFeatureToggle(CWD, AGENT, { ...at("project", saved), toggle: "ultracode" });
      expect(memory.documents.get(PROJECT)).toEqual(original);
      const reloaded = yield* store.load(CWD, AGENT, true);
      expect(reloaded.ultracode).toBe(false);
      expect(reloaded).not.toHaveProperty("automaticProfileRouting");

      const nesting = { maxDirectChildren: 8, maxDepth: 3 };
      for (const invalid of [
        { maxDirectChildren: 8, maxDepth: 99 },
        { maxDirectChildren: 0.5, maxDepth: 3 },
      ])
        yield* rejects(
          store.patchNesting(CWD, AGENT, { ...at("project", original), nesting: invalid }),
          "update",
          PROJECT,
          "Invalid nesting policy",
        );
      expect(memory.documents.get(PROJECT)).toEqual(original);
      yield* store.patchNesting(CWD, AGENT, { ...at("project", original), nesting });
      expect(memory.documents.get(PROJECT)).toEqual({ ...original, nesting });
    }),
  );

  it.effect("rejects every runtime patch of the retired key, even without a file", () =>
    Effect.gen(function* () {
      const original = { version: 6, automaticProfileRouting: { retired: true } };
      for (const scope of ["global", "project"] as const)
        for (const document of [undefined, original]) {
          const { memory, store } = yield* setup(document ? { [pathOf(scope)]: document } : {});
          for (const enabled of [true, false, undefined])
            yield* rejects(
              store.patchFeatureToggle(CWD, AGENT, {
                ...at(scope, document),
                // SAFETY: Deliberately exercises an untyped caller using the retired key.
                toggle: "automaticProfileRouting" as never,
                enabled,
              }),
              "update",
              pathOf(scope),
            );
          expect(memory.documents.get(pathOf(scope))).toEqual(document);
        }
    }),
  );

  it.effect("refuses stale, untrusted, and invalid switch writes without changing the file", () =>
    Effect.gen(function* () {
      const current = { version: 6, ultracode: true };
      const { memory, store } = yield* setup({ [PROJECT]: current });
      const base = { ...at("project", current), toggle: "ultracode", enabled: false } as const;
      // SAFETY: The typed store boundary is intentionally supplied invalid runtime values.
      for (const invalid of [
        { expectedDocument: { version: 6 } },
        { projectTrusted: false },
        { toggle: "unknownFeature" as never },
        { enabled: "false" as never },
        { toggle: "toString" as never },
      ])
        yield* rejects(
          store.patchFeatureToggle(CWD, AGENT, { ...base, ...invalid }),
          "update",
          PROJECT,
        );
      expect(memory.documents.get(PROJECT)).toEqual(current);
    }),
  );

  it.effect("migrates valid legacy documents when saving a switch or workspace preference", () =>
    Effect.gen(function* () {
      const legacy = {
        version: 5,
        profiles: { worker: declaredCandidate("openai/worker", { fastMode: true }) },
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
      };
      let { memory, store } = yield* setup({ [GLOBAL]: legacy });
      yield* store.patchFeatureToggle(CWD, AGENT, {
        ...at("global", legacy),
        toggle: "ultracode",
        enabled: true,
      });
      expect(memory.documents.get(GLOBAL)).toMatchObject({
        ...v6({ worker: { openaiFastMode: true } }),
        nesting: legacy.nesting,
        ultracode: true,
      });
      const loaded = yield* store.load(CWD, AGENT, false);
      expect([loaded.ultracode, loaded.profileSources.worker]).toEqual([true, "global"]);

      const nestingOnly = { version: 5, nesting: { maxDirectChildren: 4, maxDepth: 2 } };
      ({ memory, store } = yield* setup({ [GLOBAL]: nestingOnly }));
      yield* store.patchWriterWorkspace(CWD, AGENT, {
        ...at("global", nestingOnly),
        writerWorkspaceMode: "shared-checkout",
      });
      expect(memory.documents.get(GLOBAL)).toEqual({
        ...nestingOnly,
        version: 6,
        writerWorkspaceMode: "shared-checkout",
      });
    }),
  );
});

describe("profile declaration visit restore", () => {
  const candidate = {
    host: "local",
    runtime: "pi",
    model: "openai/worker",
    effort: "high",
    context: "fresh",
    writeIntent: "writer",
  } as const;
  const original: JsonObject = {
    version: 6,
    profileSets: {
      saved: { profiles: { worker: "disabled", scout: "disabled" } },
      other: { profiles: {} },
    },
    nesting: { maxDirectChildren: 3, maxDepth: 2 },
  };
  const restore = (document: JsonObject, patch: Partial<SubagentProfileRestorePatch> = {}) =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({ [GLOBAL]: document });
      const result = yield* store
        .restoreProfileDeclaration(CWD, AGENT, {
          ...at("global", document),
          profileSet: "saved",
          profile: "worker",
          sourceVersion: 6,
          ...patch,
        })
        .pipe(Effect.result);
      return { memory, result };
    });

  for (const declaration of [
    candidate,
    [candidate],
    { ...candidate, writeIntent: "read-only", openaiFastMode: false, closeOnReport: true },
    "disabled",
    undefined,
  ])
    it.effect(`preserves declaration ${JSON.stringify(declaration)}`, () =>
      Effect.gen(function* () {
        const { memory, result } = yield* restore(original, { declaration });
        const profiles: JsonObject = { scout: "disabled" };
        if (declaration !== undefined) profiles.worker = declaration;
        const expected = {
          ...original,
          profileSets: { saved: { profiles }, other: { profiles: {} } },
        };
        expect(result).toMatchObject({ _tag: "Success", success: expected });
        expect(memory.documents.get(GLOBAL)).toEqual(expected);
        if (result._tag === "Success") result.success.version = 99;
        expect(memory.documents.get(GLOBAL)?.version).toBe(6);
      }),
    );

  it.effect("rejects invalid or unauthorized restores without changing the document", () =>
    Effect.gen(function* () {
      let reads = 0;
      const accessor = {
        ...candidate,
        get closeOnReport() {
          reads += 1;
          return true;
        },
      };
      for (const patch of [
        { declaration: [] },
        { declaration: { ...candidate, host: "herdr" } },
        { declaration: { ...candidate, closeOnReport: false } },
        { declaration: [candidate, { ...candidate, host: "herdr" }] },
        { declaration: { ...candidate, unknown: true } },
        { declaration: { ...candidate, openaiFastMode: "false" } },
        { declaration: "broken" },
        { declaration: accessor },
        { sourceVersion: 3 },
        { profileSet: "missing" },
        { scope: "project" as const, projectTrusted: false },
        { expectedDocument: { version: 6 } },
      ]) {
        const { memory, result } = yield* restore(original, patch);
        expect(result._tag).toBe("Failure");
        expect(memory.documents.get(GLOBAL)).toEqual(original);
      }
      expect(reads).toBe(0);
    }),
  );

  it.effect("rejects an external edit inside the document transaction", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({ [GLOBAL]: original });
      memory.injectBeforeNextUpdate((current) => ({ ...current, defaultProfileSet: "other" }));
      yield* rejects(
        store.restoreProfileDeclaration(CWD, AGENT, {
          ...at("global", original),
          profileSet: "saved",
          profile: "worker",
          declaration: candidate,
          sourceVersion: 6,
        }),
        "update",
        GLOBAL,
      );
      expect(memory.documents.get(GLOBAL)).toEqual(original);
    }),
  );

  for (const version of [4, 5])
    it.effect(`migrates valid version ${version} restoration`, () =>
      Effect.gen(function* () {
        const legacy = { version, profiles: { worker: "disabled", scout: "disabled" } };
        const { memory, result } = yield* restore(legacy, {
          profileSet: "default",
          sourceVersion: version,
          declaration: [{ ...candidate, fastMode: true }],
        });
        const expected = v6({
          scout: "disabled",
          worker: [{ ...candidate, openaiFastMode: true }],
        });
        expect(result).toMatchObject({ _tag: "Success", success: expected });
        expect(memory.documents.get(GLOBAL)).toEqual(expected);
      }),
    );

  it.effect("rejects absence restoration after the target document is deleted", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup();
      yield* rejects(
        store.restoreProfileDeclaration(CWD, AGENT, {
          ...at("global"),
          profileSet: "saved",
          profile: "worker",
          sourceVersion: 6,
        }),
        "update",
        GLOBAL,
      );
      expect(memory.documents.has(GLOBAL)).toBe(false);
    }),
  );

  it.effect("rejects malformed legacy documents rather than clearing invalid routes", () =>
    Effect.gen(function* () {
      const legacy = { version: 5, profiles: { worker: "broken" } };
      const { memory, result } = yield* restore(legacy, {
        profileSet: "default",
        sourceVersion: 5,
      });
      expect(result._tag).toBe("Failure");
      expect(memory.documents.get(GLOBAL)).toEqual(legacy);
    }),
  );

  it.effect("returns the committed patch rather than a later document read", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({ [GLOBAL]: original });
      const receipt = yield* store.patchProfile(CWD, AGENT, {
        ...at("global", original),
        profileSet: "saved",
        profile: "worker",
        route: [candidate],
      });
      expect(receipt).toEqual(memory.documents.get(GLOBAL));
      const committed = structuredClone(receipt);
      memory.documents.set(GLOBAL, { ...original, defaultProfileSet: "other" });
      expect(receipt).toEqual(committed);
      expect(receipt).not.toEqual(original);
    }),
  );
});
