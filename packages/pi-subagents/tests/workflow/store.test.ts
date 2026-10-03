import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { WorkflowStore } from "../../src/workflow/store.ts";

const script = (name: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "d" };\nreturn 1;\n`;

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectWorkflows: string;
  readonly userWorkflows: string;
  readonly trust: { value: boolean };
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly write: (
    path: string,
    content: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

const fixture: Effect.Effect<
  Fixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "pi-workflow-store-" }),
  );
  const cwd = paths.join(root, "project");
  const agentDirectory = paths.join(root, "agent");
  const projectWorkflows = paths.join(cwd, ".pi", "workflows");
  const userWorkflows = paths.join(agentDirectory, "workflows");
  yield* fs.makeDirectory(projectWorkflows, { recursive: true });
  yield* fs.makeDirectory(userWorkflows, { recursive: true });
  return {
    root,
    cwd,
    agentDirectory,
    projectWorkflows,
    userWorkflows,
    trust: { value: true },
    join: (...segments: ReadonlyArray<string>) => paths.join(...segments),
    write: (path: string, content: string) => fs.writeFileString(path, content),
  } satisfies Fixture;
});

const withStore = <A, E>(
  setup: Fixture,
  use: (store: WorkflowStore["Service"]) => Effect.Effect<A, E>,
) =>
  WorkflowStore.use(use).pipe(
    Effect.provide(
      WorkflowStore.layer({
        cwd: setup.cwd,
        agentDirectory: setup.agentDirectory,
        isProjectTrusted: () => setup.trust.value,
      }).pipe(
        Layer.provide(
          Layer.merge(
            SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer)),
            nodeFilePlatformLayer,
          ),
        ),
      ),
    ),
  );

const failureMessage = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.message));

describe("saved workflows", () => {
  it.effect("prefers the trusted project's copy and falls back to the user's", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.projectWorkflows, "review.js"), script("project-review"));
      yield* setup.write(setup.join(setup.userWorkflows, "review.js"), script("user-review"));
      const trusted = yield* withStore(setup, (store) => store.load("review"));
      expect(trusted.script.meta.name).toBe("project-review");
      setup.trust.value = false;
      const untrusted = yield* withStore(setup, (store) => store.load("review"));
      expect([untrusted.scope, untrusted.script.meta.name]).toEqual(["user", "user-review"]);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("rejects unsafe names, missing workflows and invalid scripts", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.userWorkflows, "broken.js"), "export const meta = 1;");
      expect(yield* failureMessage(withStore(setup, (store) => store.load("../escape")))).toMatch(
        /Workflow names/,
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("missing")))).toMatch(
        /No saved workflow/,
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("broken")))).toMatch(
        /broken\.js/,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("does not follow symlinked workflow files", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* setup.write(setup.join(setup.root, "outside.js"), script("outside"));
      yield* fs.symlink(
        setup.join(setup.root, "outside.js"),
        setup.join(setup.userWorkflows, "linked.js"),
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("linked")))).toMatch(
        /Couldn't read/,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("loads script files relative to the session cwd", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.cwd, "draft.js"), script("drafted"));
      const loaded = yield* withStore(setup, (store) => store.loadPath("draft.js"));
      expect(loaded).toMatchObject({ name: "drafted", path: setup.join(setup.cwd, "draft.js") });
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("lists both scopes once per name with diagnostics for invalid files", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.projectWorkflows, "a.js"), script("a"));
      yield* setup.write(setup.join(setup.userWorkflows, "a.js"), script("shadowed"));
      yield* setup.write(setup.join(setup.userWorkflows, "b.js"), script("b"));
      yield* setup.write(setup.join(setup.userWorkflows, "bad.js"), "nope");
      yield* setup.write(setup.join(setup.userWorkflows, "Not Valid.js"), script("ignored"));
      const listing = yield* withStore(setup, (store) => store.list);
      expect(listing.workflows.map((workflow) => [workflow.name, workflow.scope])).toEqual([
        ["a", "project"],
        ["b", "user"],
      ]);
      expect(listing.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
        setup.join(setup.userWorkflows, "bad.js"),
      ]);
      setup.trust.value = false;
      const untrusted = yield* withStore(setup, (store) => store.list);
      expect(untrusted.workflows.map((workflow) => workflow.meta.name)).toEqual(["shadowed", "b"]);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
