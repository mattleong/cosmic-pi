// Explicit test entry-point Layer provision owns each scoped store runtime.
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodeModeConfigStore,
  type CodeModeConfigStoreShape,
  type CodeModeSettingsError,
  type CodeModeState,
} from "../src/config/store.ts";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";

const tempDirectories: string[] = [];
const runtimes: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function harness(projectTrusted: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-agent-"));
  tempDirectories.push(cwd, agentDir);
  const published: CodeModeState[] = [];
  const layer = CodeModeConfigStore.layer({
    cwd,
    projectTrusted,
    publish: (state) => published.push(state),
  }).pipe(Layer.provide(Layer.merge(nodeFilePlatformLayer, AgentDirectory.layer(agentDir))));
  // One long-lived runtime per harness: every operation exercises the same store authority.
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const use = <A, E>(body: (store: CodeModeConfigStoreShape) => Effect.Effect<A, E>): Promise<A> =>
    runtime.runPromise(CodeModeConfigStore.use((store) => body(store)));
  const globalPath = join(agentDir, "extensions", "pi-code-mode.json");
  const projectPath = join(cwd, ".pi", "extensions", "pi-code-mode.json");
  const writeDoc = (path: string, document: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document)}\n`);
  };
  const readDoc = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { cwd, agentDir, published, use, globalPath, projectPath, writeDoc, readDoc };
}

describe("code mode config store", () => {
  it("resolves locked defaults, seeds an empty global document, and freezes the state", async () => {
    const h = harness(true);
    const state = await h.use((store) => store.state);
    expect(state.config).toEqual(DEFAULT_CODE_MODE_CONFIG);
    expect(state.available).toBe(true);
    expect(state.projectTrusted).toBe(true);
    expect(state.diagnostics).toEqual([]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.config)).toBe(true);
    expect(h.readDoc(h.globalPath)).toEqual({});
    expect(h.published.length).toBeGreaterThan(0);
  });

  it("resolves project fields over global fields one field at a time", async () => {
    const h = harness(true);
    h.writeDoc(h.globalPath, { timeoutMs: 60_000, enabled: false, maxOutputBytes: 1_024 });
    h.writeDoc(h.projectPath, { enabled: true, maxToolCalls: 64 });
    const state = await h.use((store) => store.state);
    expect(state.config.enabled).toBe(true);
    expect(state.provenance.enabled).toBe("project");
    expect(state.config.timeoutMs).toBe(60_000);
    expect(state.provenance.timeoutMs).toBe("global");
    expect(state.config.maxToolCalls).toBe(64);
    expect(state.config.maxOutputBytes).toBe(1_024);
    expect(state.config.maxSourceBytes).toBe(DEFAULT_CODE_MODE_CONFIG.maxSourceBytes);
    expect(state.provenance.maxSourceBytes).toBe("default");
  });

  it("drops malformed fields independently with bounded, path-only diagnostics", async () => {
    const h = harness(true);
    h.writeDoc(h.globalPath, {
      timeoutMs: "soon",
      maxToolCalls: 64,
      catalogBudget: 999_999_999,
    });
    h.writeDoc(h.projectPath, { enabled: "yes", maxOutputBytes: 2_048 });
    const state = await h.use((store) => store.state);
    expect(state.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
    expect(state.config.catalogBudget).toBe(DEFAULT_CODE_MODE_CONFIG.catalogBudget);
    expect(state.config.maxToolCalls).toBe(64);
    expect(state.config.enabled).toBe(true);
    expect(state.config.maxOutputBytes).toBe(2_048);
    const paths = state.diagnostics.map((diagnostic) => diagnostic.path);
    expect(paths).toContain("global.config.timeoutMs");
    expect(paths).toContain("global.config.catalogBudget");
    expect(paths).toContain("project.config.enabled");
    for (const diagnostic of state.diagnostics) {
      expect(Object.keys(diagnostic).sort()).toEqual(["issue", "path"]);
      expect(diagnostic.issue).toBe("invalid");
    }
    expect(state.diagnostics.length).toBeLessThanOrEqual(32);
  });

  it("never reads the project document in an untrusted project", async () => {
    const h = harness(false);
    h.writeDoc(h.globalPath, { timeoutMs: 45_000 });
    h.writeDoc(h.projectPath, { enabled: true, timeoutMs: 1_000 });
    const state = await h.use((store) => store.state);
    expect(state.config.timeoutMs).toBe(45_000);
    expect(state.projectValues).toEqual({});
    expect(state.provenance.enabled).toBe("default");
    expect(state.available).toBe(false);
  });

  it("computes availability as trusted AND enabled across the matrix", async () => {
    const trustedDefault = harness(true);
    expect((await trustedDefault.use((store) => store.state)).available).toBe(true);

    const trustedDisabledGlobal = harness(true);
    trustedDisabledGlobal.writeDoc(trustedDisabledGlobal.globalPath, { enabled: false });
    expect((await trustedDisabledGlobal.use((store) => store.state)).available).toBe(false);

    const trustedDisabledProject = harness(true);
    trustedDisabledProject.writeDoc(trustedDisabledProject.globalPath, { enabled: true });
    trustedDisabledProject.writeDoc(trustedDisabledProject.projectPath, { enabled: false });
    expect((await trustedDisabledProject.use((store) => store.state)).available).toBe(false);

    // A global enabled: true never grants availability in an untrusted project.
    const untrustedEnabledGlobal = harness(false);
    untrustedEnabledGlobal.writeDoc(untrustedEnabledGlobal.globalPath, { enabled: true });
    expect((await untrustedEnabledGlobal.use((store) => store.state)).available).toBe(false);

    const untrustedEnabledProject = harness(false);
    untrustedEnabledProject.writeDoc(untrustedEnabledProject.projectPath, { enabled: true });
    expect((await untrustedEnabledProject.use((store) => store.state)).available).toBe(false);
  });

  it("writes, resets, and inherits fields per scope through the single door", async () => {
    const h = harness(true);
    const afterGlobal = await h.use((store) => store.setSetting("global", "timeoutMs", "60000"));
    expect(afterGlobal.config.timeoutMs).toBe(60_000);
    expect(afterGlobal.provenance.timeoutMs).toBe("global");
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 60_000 });

    const afterProject = await h.use((store) => store.setSetting("project", "timeoutMs", "45000"));
    expect(afterProject.config.timeoutMs).toBe(45_000);
    expect(afterProject.provenance.timeoutMs).toBe("project");
    expect(h.readDoc(h.projectPath)).toEqual({ timeoutMs: 45_000 });

    const afterClearProject = await h.use((store) => store.clearSetting("project", "timeoutMs"));
    expect(afterClearProject.config.timeoutMs).toBe(60_000);
    expect(afterClearProject.provenance.timeoutMs).toBe("global");
    expect(h.readDoc(h.projectPath)).toEqual({});

    const afterClearGlobal = await h.use((store) => store.clearSetting("global", "timeoutMs"));
    expect(afterClearGlobal.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
    expect(afterClearGlobal.provenance.timeoutMs).toBe("default");
    expect(h.readDoc(h.globalPath)).toEqual({});
    expect(h.published.at(-1)?.config.timeoutMs).toBe(DEFAULT_CODE_MODE_CONFIG.timeoutMs);
  });

  it("preserves unrelated JSON fields on writes and clears", async () => {
    const h = harness(true);
    h.writeDoc(h.globalPath, { future: { keep: true }, timeoutMs: 15_000 });
    await h.use((store) => store.setSetting("global", "maxToolCalls", "8"));
    expect(h.readDoc(h.globalPath)).toEqual({
      future: { keep: true },
      timeoutMs: 15_000,
      maxToolCalls: 8,
    });
    await h.use((store) => store.clearSetting("global", "timeoutMs"));
    expect(h.readDoc(h.globalPath)).toEqual({ future: { keep: true }, maxToolCalls: 8 });
  });

  it("refuses project-scope writes while the project is untrusted", async () => {
    const h = harness(false);
    const error = await h.use((store) =>
      store.setSetting("project", "enabled", "true").pipe(Effect.flip),
    );
    expect(error._tag).toBe("CodeModeUntrustedScopeError");
    const clearError = await h.use((store) =>
      store.clearSetting("project", "enabled").pipe(Effect.flip),
    );
    expect(clearError._tag).toBe("CodeModeUntrustedScopeError");
    expect(existsSync(h.projectPath)).toBe(false);
  });

  it("does not persist invalid or out-of-range integers", async () => {
    const h = harness(true);
    h.writeDoc(h.globalPath, { timeoutMs: 15_000 });
    for (const raw of ["nope", "1.5", "999999999"]) {
      const error: CodeModeSettingsError = await h.use((store) =>
        store.setSetting("global", "timeoutMs", raw).pipe(Effect.flip),
      );
      expect(error._tag).toBe("InvalidCodeModeSettingError");
    }
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 15_000 });
  });

  it("rejects unknown setting identifiers without touching documents", async () => {
    const h = harness(true);
    const error = await h.use((store) =>
      store.setSetting("global", "notASetting", "1").pipe(Effect.flip),
    );
    expect(error._tag).toBe("CodeModeConfigError");
    expect(h.readDoc(h.globalPath)).toEqual({});
  });
});
