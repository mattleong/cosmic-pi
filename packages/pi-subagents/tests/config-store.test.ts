import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { JsonDocumentError, JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import {
  makeInMemoryDocuments,
  type InMemoryDocuments,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
import {
  SubagentConfigConflictError,
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
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";

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
  attempt: Effect.Effect<A, SubagentConfigStoreError | SubagentConfigConflictError>,
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

const conflicts = <A>(
  attempt: Effect.Effect<A, SubagentConfigStoreError | SubagentConfigConflictError>,
  path: string,
) =>
  Effect.flip(attempt).pipe(
    Effect.map((error) => {
      expect(error).toBeInstanceOf(SubagentConfigConflictError);
      expect(error).toMatchObject({ path });
    }),
  );

const writes = (memory: InMemoryDocuments) =>
  Arr.filter(memory.operations, (operation) => /^(modify|write):/u.test(operation));

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

  it.effect(
    "never reads an untrusted project, and a trusted project's invalid mode isolates writers",
    () =>
      Effect.gen(function* () {
        const { memory, store } = yield* setup({
          [GLOBAL]: { version: 6, writerWorkspaceMode: "shared-checkout" },
          [PROJECT]: { version: 6, writerWorkspaceMode: "worktrees" },
        });
        expect((yield* store.load(CWD, AGENT, false)).writerWorkspaceMode).toBe("shared-checkout");
        expect(memory.operations).not.toContain(`read:${PROJECT}`);
        const trusted = yield* store.load(CWD, AGENT, true);
        expect(trusted.writerWorkspaceMode).toBe("worktree");
        expect(trusted.diagnostics).toEqual(["project.writerWorkspaceMode"]);
      }),
  );

  it.effect("activates past invalid fields, failing safety controls closed", () =>
    Effect.gen(function* () {
      const { memory, store } = yield* setup({
        [GLOBAL]: {
          version: 6,
          nesting: { maxDepth: 5, maxActiveRuns: 40 },
          delegation: "encouraged",
          sessionSpendLimit: 10,
        },
        [PROJECT]: {
          version: 6,
          workspaceSetup: { command: ["pnpm", "install"] },
          nesting: { maxDirectChildren: 4, maxDepth: "deep", extra: true },
          writerWorkspaceMode: "elsewhere",
          delegation: 7,
          sessionSpendLimit: -1,
          hooks: "pnpm install",
        },
      });
      const config = yield* store.load(CWD, AGENT, true);
      expect(config.nesting).toEqual({ maxDirectChildren: 4, maxDepth: 0, maxActiveRuns: 40 });
      expect(config.writerWorkspaceMode).toBe("worktree");
      expect(config.delegation).toBe("encouraged");
      // Another scope's valid limit still applies.
      expect(config.sessionSpendLimit).toEqual({ kind: "limited", dollars: 10 });
      expect(config.hooks).toEqual({
        WorktreeCreate: [],
        WorktreeRemove: [],
        invalidWorktreeCreate: ["project.hooks"],
      });
      expect(Arr.sort(config.diagnostics, Order.String)).toEqual(
        Arr.sort(
          [
            "project.<unknown>",
            "project.nesting.<unknown>",
            "project.nesting.maxDepth",
            "project.writerWorkspaceMode",
            "project.delegation",
            "project.sessionSpendLimit",
            "project.hooks",
          ],
          Order.String,
        ),
      );
      expect(writes(memory)).toEqual([]);
    }),
  );

  it.effect("clamps out-of-range limits to their bounds with a diagnostic", () =>
    Effect.gen(function* () {
      const { store } = yield* setup({
        [GLOBAL]: {
          version: 6,
          nesting: { maxDirectChildren: 0, maxDepth: 99, maxActiveRuns: 1_000 },
          sessionSpendLimit: 1_000_000,
          hooks: {
            WorktreeCreate: [
              { command: ["fast"], timeout: 0 },
              { command: ["slow"], timeout: 99_999 },
              { command: ["fraction"], timeout: 1.5 },
            ],
          },
        },
      });
      const config = yield* store.load(CWD, AGENT, false);
      expect(config.nesting).toEqual({ maxDirectChildren: 1, maxDepth: 8, maxActiveRuns: 64 });
      expect(config.sessionSpendLimit).toEqual({ kind: "limited", dollars: 100_000 });
      expect(config.hooks.WorktreeCreate).toEqual([
        { command: ["fast"], timeout: 1, scope: "global" },
        { command: ["slow"], timeout: 3_600, scope: "global" },
        { command: ["fraction"], timeout: 1, scope: "global" },
      ]);
      expect(config.hooks.invalidWorktreeCreate).toEqual([]);
      expect(config.diagnostics).toEqual(
        expect.arrayContaining([
          "global.nesting.maxDirectChildren",
          "global.nesting.maxDepth",
          "global.nesting.maxActiveRuns",
          "global.sessionSpendLimit",
          "global.hooks.WorktreeCreate[0].timeout",
          "global.hooks.WorktreeCreate[1].timeout",
          "global.hooks.WorktreeCreate[2].timeout",
        ]),
      );
    }),
  );

  it.effect("blocks spending when the only declared spend limit is invalid", () =>
    Effect.gen(function* () {
      for (const sessionSpendLimit of ["10", 0, -5, null, true]) {
        const { store } = yield* setup({
          [GLOBAL]: v6({}),
          [PROJECT]: { version: 6, sessionSpendLimit },
        });
        const config = yield* store.load(CWD, AGENT, true);
        expect(config.sessionSpendLimit).toEqual({
          kind: "invalid",
          diagnostic: "project.sessionSpendLimit",
        });
        expect(config.diagnostics).toEqual(["project.sessionSpendLimit"]);
        expect((yield* store.load(CWD, AGENT, false)).sessionSpendLimit).toBeUndefined();
      }
    }),
  );

  it.effect("still fails activation on an unsupported version", () =>
    Effect.gen(function* () {
      const { store } = yield* setup({ [GLOBAL]: v6({}), [PROJECT]: { version: 5 } });
      yield* rejects(store.load(CWD, AGENT, true), "activate", PROJECT, "version 6");
    }),
  );

  it.effect("drops malformed WorktreeRemove hooks but blocks setup on a malformed create", () =>
    Effect.gen(function* () {
      const create = { command: ["pnpm", "install"] };
      const remove = { command: ["./cleanup"], timeout: 30 };
      const { store } = yield* setup({
        [GLOBAL]: v6({}, { hooks: { WorktreeCreate: [create], Unknown: [create] } }),
        [PROJECT]: {
          version: 6,
          hooks: {
            WorktreeCreate: [create, { command: "./seed-db" }],
            WorktreeRemove: [{ command: "./cleanup" }, remove, { ...remove, shell: true }],
          },
        },
      });
      const config = yield* store.load(CWD, AGENT, true);
      expect(config.hooks).toEqual({
        WorktreeCreate: [
          { ...create, scope: "global" },
          { ...create, scope: "project" },
        ],
        WorktreeRemove: [{ ...remove, scope: "project" }],
        invalidWorktreeCreate: ["project.hooks.WorktreeCreate[1]"],
      });
      expect(config.diagnostics).toEqual([
        "global.hooks.<unknown>",
        "project.hooks.WorktreeCreate[1]",
        "project.hooks.WorktreeRemove[0]",
        "project.hooks.WorktreeRemove[2]",
      ]);
      const untrusted = (yield* store.load(CWD, AGENT, false)).hooks;
      expect(untrusted.WorktreeRemove).toEqual([]);
      expect(untrusted.invalidWorktreeCreate).toEqual([]);
    }),
  );

  it.effect("fails activation closed on an unreadable document", () =>
    Effect.gen(function* () {
      const unreadable = Layer.succeed(
        JsonDocumentStore,
        JsonDocumentStore.of({
          ...makeInMemoryDocuments().service,
          readObject: (path) =>
            Effect.fail(JsonDocumentError.make({ operation: "read", path, message: "Bad JSON." })),
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
        yield* conflicts(write, GLOBAL);
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
      expect(Arr.map(loaded.config.agents, (agent) => agent.name)).toEqual(["auth-reviewer"]);

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
        isRecord(saved) &&
          isRecord(saved["auth-reviewer"]) &&
          Rec.keys<string, unknown>(saved["auth-reviewer"]),
      ).toEqual(Rec.keys<string, unknown>(agents["auth-reviewer"]));
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
  if (Arr.isArray(value)) return Arr.map(value, keyOrder);
  return isRecord(value)
    ? Arr.map(Rec.toEntries(value), ([key, item]) => [key, keyOrder(item)])
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
      yield* conflicts(
        store.restoreProfileDeclaration(CWD, AGENT, {
          ...at("global", original),
          profileSet: "saved",
          profile: "worker",
          declaration: candidate,
        }),
        GLOBAL,
      );
      expect(memory.documents.get(GLOBAL)).toEqual(original);
    }),
  );
});
