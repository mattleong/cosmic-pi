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
import { isRecord } from "../src/config/profile-restore.ts";
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import { objectContaining, stringContaining } from "./support/matchers.ts";

const CWD = "/repo";
const AGENT = "/agent";
const GLOBAL = `${AGENT}/pi-subagents.json`;
const PROJECT = `${CWD}/${CONFIG_DIR_NAME}/pi-subagents.json`;

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
  it.effect(
    "fails a route with an unknown candidate key closed in every scope without load writes",
    () =>
      Effect.gen(function* () {
        const local = declaredCandidate("openai/local");
        for (const scope of ["global", "project"] as const)
          for (const runtime of ["pi", "claude", "codex"])
            for (const invalidFirst of [true, false]) {
              const invalid = declaredCandidate(runtime === "pi" ? "openai/invalid" : "native", {
                host: "local",
                runtime,
              });
              const raw = v6({
                worker: invalidFirst ? [invalid, local] : [local, invalid],
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
      expect(config.profiles.worker).toEqual({
        candidates: [
          {
            runtime: "pi",
            model: "openai/worker",
            effort: "high",
            context: "fresh",
            writeIntent: "writer",
          },
        ],
      });
      expect(config.profileSources.worker).toBe("global");
      expect(config.fallbackProfile).toBe("generalist");
      expect(config.nesting).toEqual({ maxDirectChildren: 12, maxDepth: 3, maxActiveRuns: 16 });
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

  it.effect("activates hooks from both scopes and refuses removed or malformed hook fields", () =>
    Effect.gen(function* () {
      const create = { command: ["pnpm", "install"] };
      const remove = { command: ["./cleanup"], timeout: 30 };
      const { store } = yield* setup({
        [GLOBAL]: v6({}, { hooks: { WorktreeCreate: [create] } }),
        [PROJECT]: { version: 6, hooks: { WorktreeRemove: [remove] } },
      });
      expect((yield* store.load(CWD, AGENT, true)).hooks).toEqual({
        WorktreeCreate: [{ ...create, scope: "global" }],
        WorktreeRemove: [{ ...remove, scope: "project" }],
      });
      expect((yield* store.load(CWD, AGENT, false)).hooks.WorktreeRemove).toEqual([]);

      for (const project of [
        { version: 6, workspaceSetup: create },
        { version: 6, workspaceVerify: create },
        { version: 6, workspaceInclude: [".env"] },
        { version: 6, hooks: { WorktreeCreate: [{ command: ["pnpm"], timeout: 0 }] } },
      ]) {
        const invalid = yield* setup({ [GLOBAL]: v6({}), [PROJECT]: project });
        yield* rejects(invalid.store.load(CWD, AGENT, true), "activate", PROJECT);
      }
      const global = yield* setup({ [GLOBAL]: v6({}, { hooks: { Unknown: [create] } }) });
      yield* rejects(global.store.load(CWD, AGENT, true), "activate", GLOBAL);
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
});

describe("SubagentConfigStore profile writes", () => {
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
});

describe("SubagentConfigStore custom agents", () => {
  it.effect("activates agents and keeps them byte-for-byte through settings writes", () =>
    Effect.gen(function* () {
      const agents = {
        "auth-reviewer": {
          description: "Reviews auth changes.",
          instructions: "Review only authentication code.\nCite file and line.",
          profile: "reviewer",
          effort: "xhigh",
          tools: { allow: ["read", "grep"], deny: [] },
        },
      };
      const initial = v6({ scout: declaredCandidate("parent", { effort: "default" }) }, { agents });
      const { memory, store } = yield* setup({ [GLOBAL]: initial });
      const loaded = yield* store.inspect(CWD, AGENT, true);
      expect(loaded.config.agents.map((agent) => agent.name)).toEqual(["auth-reviewer"]);

      yield* store.patchProfile(CWD, AGENT, {
        ...at("global", initial),
        profileSet: "default",
        profile: "worker",
        route: "disabled",
      });
      const patched = memory.documents.get(GLOBAL);
      yield* store.patchDelegation(CWD, AGENT, {
        ...at("global", patched),
        delegation: "encouraged",
      });
      const delegated = memory.documents.get(GLOBAL);
      yield* store.createProfileSetFromSnapshot(CWD, AGENT, {
        ...at("global", delegated),
        profileSet: "copy",
        profiles: BUILTIN_PROFILE_ROUTES,
      });
      const saved = memory.documents.get(GLOBAL)?.agents;
      expect(saved).toStrictEqual(agents);
      expect(
        isRecord(saved) && isRecord(saved["auth-reviewer"]) && Object.keys(saved["auth-reviewer"]),
      ).toEqual(Object.keys(agents["auth-reviewer"]));
    }),
  );
});

describe("SubagentConfigStore profile sets", () => {
  it.effect("creates, copies, renames, selects, and safely deletes scope-local sets", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup();
      const current = () => at("global", memory.documents.get(GLOBAL));
      yield* store.createProfileSetFromSnapshot(CWD, AGENT, {
        ...current(),
        profileSet: "alpha",
        profiles: BUILTIN_PROFILE_ROUTES,
      });
      expect(memory.documents.get(GLOBAL)?.profileSets).toEqual({
        alpha: {
          profiles: objectContaining({
            scout: [
              {
                runtime: "pi",
                model: "parent",
                effort: "default",
                context: "fresh",
                writeIntent: "read-only",
              },
            ],
          }),
        },
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
});

type KeyOrder = string | number | boolean | null | ReadonlyArray<KeyOrder>;
const keyOrder = (value: JsonObject[string] | undefined): KeyOrder => {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(keyOrder);
  return isRecord(value)
    ? Object.entries(value).map(([key, item]) => [key, keyOrder(item)])
    : value;
};

const savedWorker = (document: JsonObject | undefined): JsonObject[string] | undefined => {
  const sets = document?.profileSets;
  const saved = isRecord(sets) ? sets.saved : undefined;
  const profiles = isRecord(saved) ? saved.profiles : undefined;
  return isRecord(profiles) ? profiles.worker : undefined;
};

describe("profile declaration visit restore", () => {
  const candidate = {
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

  const reordered = {
    writeIntent: "writer",
    model: "openai/worker",
    effort: "high",
    runtime: "pi",
    context: "fresh",
  } as const;
  for (const declaration of [candidate, [reordered, candidate]])
    it.effect(`preserves declaration ${JSON.stringify(declaration)}`, () =>
      Effect.gen(function* () {
        const { memory, result } = yield* restore(original, { declaration });
        expect(keyOrder(savedWorker(memory.documents.get(GLOBAL)))).toEqual(keyOrder(declaration));
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
      for (const patch of [
        { declaration: [] },
        { declaration: { ...candidate, host: "local" } },
        { declaration: { ...candidate, closeOnReport: true } },
        { declaration: [candidate, { ...candidate, host: "local" }] },
        { declaration: { ...candidate, unknown: true } },
        { declaration: { ...candidate, openaiFastMode: "false" } },
        { declaration: "broken" },
        { profileSet: "missing" },
        { scope: "project" as const, projectTrusted: false },
        { expectedDocument: { version: 6 } },
      ]) {
        const { memory, result } = yield* restore(original, patch);
        expect(result._tag).toBe("Failure");
        expect(memory.documents.get(GLOBAL)).toEqual(original);
      }
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
});
