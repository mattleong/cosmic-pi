import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  JsonDocumentError,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonObject,
} from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import {
  SubagentConfigStore,
  subagentConfigStoreLayer,
  type SubagentConfigScope,
  type SubagentConfigStoreError,
  type SubagentProfileRestorePatch,
} from "../src/config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
import { PROFILE_IDS, type ProfileRoute } from "../src/profiles/model.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import { objectContaining, stringContaining } from "./support/matchers.ts";

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

const at = (scope: SubagentConfigScope, document?: JsonObject) => ({
  scope,
  projectTrusted: true,
  expectedExists: document !== undefined,
  ...(document !== undefined && { expectedDocument: document }),
});

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
        ...(message !== undefined && { message: stringContaining(message) }),
      }),
    ),
  );

const writes = (memory: InMemoryDocuments) =>
  memory.operations.filter((operation) => /^(modify|write):/u.test(operation));

describe("SubagentConfigStore activation", () => {
  it.effect("fails mixed retired routes closed in every scope without load writes", () =>
    Effect.gen(function* () {
      const local = declaredCandidate("openai/local");
      for (const scope of ["global", "project"] as const)
        for (const runtime of ["pi", "claude", "codex"])
          for (const remoteFirst of [true, false]) {
            const remote = declaredCandidate(runtime === "pi" ? "openai/remote" : "native", {
              host: "herdr",
              runtime,
            });
            const raw = v6({
              worker: remoteFirst ? [remote, local] : [local, remote],
              scout: local,
            });
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

  it.effect("loads routes with nesting defaults and project inheritance", () =>
    Effect.gen(function* () {
      const worker = declaredCandidate("openai/worker", { writeIntent: "writer" });
      const { store } = yield* setup({
        [GLOBAL]: v6({ worker }),
        [PROJECT]: { version: 6 },
      });
      const config = yield* store.load(CWD, AGENT, true);
      expect(config.profiles.worker).toEqual({ candidates: [worker] });
      expect(config.profileSources.worker).toBe("global");
      expect(config.fallbackProfile).toBe("generalist");
      expect(config.nesting).toEqual({ maxDirectChildren: 12, maxDepth: 3, maxActiveRuns: 16 });
    }),
  );

  it.effect("rejects unsupported or malformed documents at activation", () =>
    Effect.gen(function* () {
      for (const document of [
        { version: 1 },
        { version: 2 },
        {},
        { version: "6" },
        { version: 4, profiles: {} },
        { version: 5, nesting: { maxDirectChildren: 12, maxDepth: 3 } },
        { version: 6, profiles: {} },
        { version: 6, defaultProfile: "generalist" },
        { version: 6, customFutureField: true },
        { version: 6, nesting: { maxDirectChildren: 0, maxDepth: 3 } },
        { version: 6, nesting: { maxDirectChildren: 33, maxDepth: 3 } },
        { version: 6, nesting: { maxDirectChildren: 12, maxDepth: -1 } },
        { version: 6, nesting: { maxDirectChildren: 12, maxDepth: 9 } },
        { version: 6, nesting: { maxDirectChildren: 12.5, maxDepth: 3 } },
        { version: 6, writerWorkspaceMode: "invalid" },
        { version: 6, delegation: "always" },
        { version: 6, automaticProfileRouting: false },
      ]) {
        const { store } = yield* setup({ [GLOBAL]: document });
        yield* rejects(store.load(CWD, AGENT, true), "activate", GLOBAL);
      }
      const { store } = yield* setup({
        [GLOBAL]: { version: 5, profiles: { worker: declaredCandidate("openai/worker") } },
      });
      yield* rejects(store.load(CWD, AGENT, true), "activate", GLOBAL, "must declare version 6");
    }),
  );

  it.effect("never reads an untrusted project, so its invalid values cannot block activation", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({
        [GLOBAL]: { version: 6, writerWorkspaceMode: "worktree" },
        [PROJECT]: { version: 6, writerWorkspaceMode: "invalid" },
      });
      expect((yield* store.load(CWD, AGENT, false)).writerWorkspaceMode).toBe("worktree");
      expect(memory.operations).not.toContain(`read:${PROJECT}`);
      yield* rejects(store.load(CWD, AGENT, true), "activate", PROJECT);
    }),
  );

  it.effect("fails activation closed on an unreadable document", () =>
    Effect.gen(function* () {
      const unreadable = Layer.succeed(
        JsonDocumentStore,
        JsonDocumentStore.of({
          ...makeInMemoryDocuments().service,
          readObject: (path) =>
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

      ({ store } = yield* setup({ [GLOBAL]: v6({ delegate: "disabled" }) }));
      config = yield* store.load(CWD, AGENT, true);
      expect(config.profileSources.generalist).toBe("builtin");
      expect(config.diagnostics).toContain("global.profileSets[0].profiles.<unknown>");
    }),
  );

  it.effect("applies strict nesting precedence", () =>
    Effect.gen(function* () {
      const { store } = yield* setup({
        [GLOBAL]: { version: 6, nesting: { maxDirectChildren: 20, maxDepth: 6 } },
        [PROJECT]: { version: 6, nesting: { maxDirectChildren: 4, maxDepth: 2 } },
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

describe("SubagentConfigStore delegation", () => {
  it.effect("prefers a trusted project's delegation over global and defaults to normal", () =>
    Effect.gen(function* () {
      const { store } = yield* setup({
        [GLOBAL]: { version: 6, delegation: "encouraged" },
        [PROJECT]: { version: 6, delegation: "orchestration" },
      });
      expect((yield* store.load(CWD, AGENT, true)).delegation).toBe("orchestration");
      expect((yield* store.load(CWD, AGENT, false)).delegation).toBe("encouraged");
      const empty = yield* setup({});
      expect((yield* empty.store.load(CWD, AGENT, true)).delegation).toBe("normal");
    }),
  );

  it.effect("saves and clears delegation while preserving every other field", () =>
    Effect.gen(function* () {
      const original = {
        version: 6,
        defaultProfileSet: "saved",
        profileSets: { saved: { profiles: { worker: "disabled" } } },
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
      };
      const { memory, store } = yield* setup({ [GLOBAL]: original });
      yield* store.patchDelegation(CWD, AGENT, {
        ...at("global", original),
        delegation: "orchestration",
      });
      const saved = { ...original, delegation: "orchestration" };
      expect(memory.documents.get(GLOBAL)).toEqual(saved);
      expect((yield* store.load(CWD, AGENT, false)).delegation).toBe("orchestration");
      yield* store.patchDelegation(CWD, AGENT, at("global", saved));
      expect(memory.documents.get(GLOBAL)).toEqual(original);
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
      const local = profileCandidate("openai/local");
      const document = v6({ worker: declaredCandidate("openai/local") });
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
      const staysOpen = { ...local, closeOnReport: false };
      const withUnknownField = { ...local, unknown: undefined };
      for (const route of [
        staysOpen,
        withUnknownField,
        [local, staysOpen],
        accessor,
        accessorArray,
      ]) {
        yield* rejects(
          store.patchProfile(CWD, AGENT, {
            ...at("global", document),
            profileSet: "default",
            profile: "worker",
            route,
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

  it.effect("atomically patches one profile while preserving unrelated routes", () =>
    Effect.gen(function* () {
      const reviewer = [
        declaredCandidate("openai/first", { effort: "medium" }),
        declaredCandidate("openai/second"),
      ];
      const initial = v6({ scout: declaredCandidate("parent", { effort: "default" }), reviewer });
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
        ...initial,
        profileSets: { default: { profiles: { scout, reviewer } } },
      });
      const refreshed = yield* store.inspect(CWD, AGENT, true);
      expect(refreshed.config.profiles.scout.candidates[0]?.openaiFastMode).toBe(true);
    }),
  );

  it.effect("removes inherited routes and rejects untrusted project writes", () =>
    Effect.gen(function* () {
      const initial = v6({
        worker: declaredCandidate("parent", { effort: "default" }),
        reviewer: "disabled",
      });
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
      const scoutDocument = (effort: string) =>
        v6({ scout: declaredCandidate("parent", { effort }) });
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
        expect(memory.documents.has(pathOf(scope))).toBe(false);
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
      yield* store.patchWriterWorkspace(CWD, AGENT, {
        ...at("global"),
        writerWorkspaceMode: "worktree",
      });
      expect(memory.documents.get(GLOBAL)).toEqual({ version: 6, writerWorkspaceMode: "worktree" });
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
        profileSets: { main: { profiles: objectContaining({ generalist }) } },
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
      const reviewer = profileCandidate("openai/reviewer");
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
      const routes: ReadonlyArray<readonly [string, ProfileRoute]> = [
        [
          "route-accessor",
          Object.defineProperty({ candidates: [reviewer] }, "candidates", throwingGetter),
        ],
        [
          "element-accessor",
          { candidates: Object.defineProperty([reviewer], "0", throwingGetter) },
        ],
        [
          "candidate-accessor",
          { candidates: [Object.defineProperty({ ...reviewer }, "model", throwingGetter)] },
        ],
        ["custom-iterator", { candidates: customIterator }],
      ];
      for (const [profileSet, route] of routes) {
        const profiles = { ...config.profiles, reviewer: route };
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
        yield* store.patchWriterWorkspace(CWD, AGENT, at("global", saved));
        expect(memory.documents.get(GLOBAL)).toEqual(original);
        expect((yield* store.load(CWD, AGENT, false)).writerWorkspaceMode).toBe("shared-checkout");
      }),
  );

  it.effect("saves nesting while preserving every other field", () =>
    Effect.gen(function* () {
      const original = {
        version: 6,
        defaultProfileSet: "saved",
        profileSets: { saved: { profiles: { worker: "disabled" } } },
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
        writerWorkspaceMode: "worktree",
      };
      const { memory, store } = yield* setup({ [PROJECT]: original });
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
        expect(Result.isSuccess(result) && result.success).toMatchObject(expected);
        expect(memory.documents.get(GLOBAL)).toEqual(expected);
        if (Result.isSuccess(result)) result.success.version = 99;
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
        }),
        "update",
        GLOBAL,
      );
      expect(memory.documents.get(GLOBAL)).toEqual(original);
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
        }),
        "update",
        GLOBAL,
      );
      expect(memory.documents.has(GLOBAL)).toBe(false);
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
