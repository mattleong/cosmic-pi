// Explicit test entry-point Layer provision owns each scoped store runtime.
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach } from "vitest";
import {
  CodeModeConfigStore,
  type CodeModeConfigStoreContract,
  type CodeModeSettingsError,
  type CodeModeState,
} from "../src/config/store.ts";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = nodeFsModule;
const { dirname, join } = nodePathModule;

const tempDirectories: string[] = [];
const runtimes: { dispose: () => Promise<void> }[] = [];
const disposeRuntimes = (): Promise<void> => {
  const runtime = runtimes.shift();
  if (!runtime) return Promise.resolve();
  return runtime.dispose().then(disposeRuntimes);
};
afterEach(() =>
  disposeRuntimes().then(() => {
    for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  }),
);

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-agent-"));
  tempDirectories.push(cwd, agentDir);
  const published: CodeModeState[] = [];
  const layer = CodeModeConfigStore.layer({
    cwd,
    projectTrusted: true,
    publish: (state) => published.push(state),
  }).pipe(Layer.provide(Layer.merge(nodeFilePlatformLayer, AgentDirectory.layer(agentDir))));
  // One long-lived runtime per harness: every operation exercises the same store authority.
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const use = <A, E>(
    body: (store: CodeModeConfigStoreContract) => Effect.Effect<A, E>,
  ): Promise<A> => runtime.runPromise(CodeModeConfigStore.use((store) => body(store)));
  const globalPath = join(agentDir, "extensions", "pi-code-mode.json");
  const projectPath = join(cwd, ".pi", "extensions", "pi-code-mode.json");
  const writeDoc = (path: string, document: Schema.JsonObject) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document)}\n`);
  };
  const readDoc = (path: string): Schema.JsonObject =>
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(readFileSync(path, "utf8")),
    );
  return { cwd, agentDir, published, use, globalPath, projectPath, writeDoc, readDoc };
}

describe("code mode config store", () => {
  it.effect("resolves locked defaults, seeds an empty global document, and freezes the state", () =>
    Effect.gen(function* () {
      const h = harness();
      const state = yield* Effect.promise(() => h.use((store) => Effect.sync(store.snapshot)));
      expect(state.config).toEqual(DEFAULT_CODE_MODE_CONFIG);
      expect(state.available).toBe(true);
      expect(state.projectTrusted).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.config)).toBe(true);
      expect(h.readDoc(h.globalPath)).toEqual({});
      expect(h.published.length).toBeGreaterThan(0);
    }),
  );

  it.effect("resolves project fields over global fields one field at a time", () =>
    Effect.gen(function* () {
      const h = harness();
      h.writeDoc(h.globalPath, { timeoutMs: 60_000, enabled: false, maxOutputBytes: 1_024 });
      h.writeDoc(h.projectPath, { enabled: true, maxToolCalls: 64 });
      const state = yield* Effect.promise(() => h.use((store) => Effect.sync(store.snapshot)));
      expect(state.config.enabled).toBe(true);
      expect(state.provenance.enabled).toBe("project");
      expect(state.config.timeoutMs).toBe(60_000);
      expect(state.provenance.timeoutMs).toBe("global");
      expect(state.config.maxToolCalls).toBe(64);
      expect(state.config.maxOutputBytes).toBe(1_024);
      expect(state.config.maxSourceBytes).toBe(DEFAULT_CODE_MODE_CONFIG.maxSourceBytes);
      expect(state.provenance.maxSourceBytes).toBe("default");
    }),
  );

  it.effect("drops malformed fields independently", () =>
    Effect.gen(function* () {
      const h = harness();
      h.writeDoc(h.globalPath, {
        timeoutMs: "soon",
        maxToolCalls: 64,
        catalogBudget: 999_999_999,
      });
      h.writeDoc(h.projectPath, { enabled: "yes", maxOutputBytes: 2_048 });
      const state = yield* Effect.promise(() => h.use((store) => Effect.sync(store.snapshot)));
      expect(state.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
      expect(state.config.catalogBudget).toBe(DEFAULT_CODE_MODE_CONFIG.catalogBudget);
      expect(state.config.maxToolCalls).toBe(64);
      expect(state.config.enabled).toBe(true);
      expect(state.config.maxOutputBytes).toBe(2_048);
      expect(state.globalValues).toEqual({ maxToolCalls: 64 });
      expect(state.projectValues).toEqual({ maxOutputBytes: 2_048 });
    }),
  );

  it.effect("writes, resets, and inherits fields per scope through the single door", () =>
    Effect.gen(function* () {
      const h = harness();
      const afterGlobal = yield* Effect.promise(() =>
        h.use((store) => store.setSetting("global", "timeoutMs", "60000")),
      );
      expect(afterGlobal.config.timeoutMs).toBe(60_000);
      expect(afterGlobal.provenance.timeoutMs).toBe("global");
      expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 60_000 });

      const afterProject = yield* Effect.promise(() =>
        h.use((store) => store.setSetting("project", "timeoutMs", "45000")),
      );
      expect(afterProject.config.timeoutMs).toBe(45_000);
      expect(afterProject.provenance.timeoutMs).toBe("project");
      expect(h.readDoc(h.projectPath)).toEqual({ timeoutMs: 45_000 });

      // Global writes keep trusted project values and overlay global-only fields.
      const afterGlobalOnly = yield* Effect.promise(() =>
        h.use((store) => store.setSetting("global", "enabled", "false")),
      );
      expect(afterGlobalOnly.config.timeoutMs).toBe(45_000);
      expect(afterGlobalOnly.provenance.timeoutMs).toBe("project");
      expect(afterGlobalOnly.config.enabled).toBe(false);
      expect(afterGlobalOnly.provenance.enabled).toBe("global");

      const afterClearProject = yield* Effect.promise(() =>
        h.use((store) => store.clearSetting("project", "timeoutMs")),
      );
      expect(afterClearProject.config.timeoutMs).toBe(60_000);
      expect(afterClearProject.provenance.timeoutMs).toBe("global");
      expect(h.readDoc(h.projectPath)).toEqual({});

      const afterClearGlobal = yield* Effect.promise(() =>
        h.use((store) => store.clearSetting("global", "timeoutMs")),
      );
      expect(afterClearGlobal.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
      expect(afterClearGlobal.provenance.timeoutMs).toBe("default");
      expect(h.readDoc(h.globalPath)).toEqual({ enabled: false });
      expect(h.published.at(-1)?.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
    }),
  );

  it.effect("preserves unrelated JSON fields on writes and clears", () =>
    Effect.gen(function* () {
      const h = harness();
      h.writeDoc(h.globalPath, { future: { keep: true }, timeoutMs: 15_000 });
      yield* Effect.promise(() =>
        h.use((store) => store.setSetting("global", "maxToolCalls", "8")),
      );
      expect(h.readDoc(h.globalPath)).toEqual({
        future: { keep: true },
        timeoutMs: 15_000,
        maxToolCalls: 8,
      });
      yield* Effect.promise(() => h.use((store) => store.clearSetting("global", "timeoutMs")));
      expect(h.readDoc(h.globalPath)).toEqual({ future: { keep: true }, maxToolCalls: 8 });
    }),
  );

  it.effect("does not persist invalid or out-of-range integers", () =>
    Effect.gen(function* () {
      const h = harness();
      h.writeDoc(h.globalPath, { timeoutMs: 15_000 });
      for (const raw of ["nope", "1.5", "999999999"]) {
        const error: CodeModeSettingsError = yield* Effect.promise(() =>
          h.use((store) => store.setSetting("global", "timeoutMs", raw).pipe(Effect.flip)),
        );
        expect(error._tag).toBe("InvalidCodeModeSettingError");
      }
      expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 15_000 });
    }),
  );

  it.effect("rejects unknown setting identifiers without touching documents", () =>
    Effect.gen(function* () {
      const h = harness();
      const error = yield* Effect.promise(() =>
        h.use((store) => store.setSetting("global", "notASetting", "1").pipe(Effect.flip)),
      );
      expect(error._tag).toBe("CodeModeConfigError");
      expect(h.readDoc(h.globalPath)).toEqual({});
    }),
  );
});
