// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, beforeEach, test } from "vitest";
import { setActivePlatformRunner } from "../boundary/platform";
import { makeCodePreviewRuntime, setActiveCodePreviewRuntime } from "../boundary/runtime";
import { ShikiAdapter, type ShikiHighlighter } from "../boundary/shiki";
import { CodePreviewSession } from "../session-service";
import { codePreviewSettings, setCodePreviewSettings } from "../settings/index";
import { getShikiStatus, initializeShiki, renderWithShiki } from "./shiki";

let previousCodePreviewSettings = { ...codePreviewSettings };

const fakeHighlighter = (dispose: () => void) =>
  ({
    dispose,
    codeToTokensBase: (code: string) => [[{ content: code, color: "#ffffff" }]],
  }) as unknown as ShikiHighlighter;

beforeEach(() => {
  previousCodePreviewSettings = { ...codePreviewSettings };
});

afterEach(async () => {
  setCodePreviewSettings(previousCodePreviewSettings);
  setActiveCodePreviewRuntime(undefined);
  setActivePlatformRunner(undefined);
  await initializeShiki(previousCodePreviewSettings.shikiTheme);
});

test("concurrent initialization is single-flight and the latest theme wins", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "vitesse-black",
    syntaxHighlighting: true,
  });
  const before = getShikiStatus().statusVersion;
  await Promise.all([initializeShiki("vitesse-black"), initializeShiki("vitesse-black")]);
  assert.equal(getShikiStatus().statusVersion, before + 1);

  await Promise.all([
    initializeShiki("github-light-high-contrast"),
    initializeShiki("vitesse-black"),
  ]);
  const rendered = renderWithShiki("const latest = true;", "typescript")?.[0] ?? "";
  assert.match(rendered, /\x1b\[38;2;139;148;158m/);
});

test("initializeShiki does not mutate configured settings", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "dark-plus",
    syntaxHighlighting: true,
  });
  await initializeShiki("github-light-high-contrast");

  assert.equal(codePreviewSettings.shikiTheme, "dark-plus");
});

test("light Shiki themes preserve their dark foreground colors", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "github-light-high-contrast",
    syntaxHighlighting: true,
  });
  await initializeShiki("github-light-high-contrast");

  const rendered = renderWithShiki("const value = 1;", "typescript")?.[0] ?? "";
  assert.doesNotMatch(rendered, /\x1b\[38;2;139;148;158m/);
  assert.match(rendered, /\x1b\[38;2;14;17;22m/);
});

test("dark Shiki themes still normalize low-contrast foreground colors", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "vitesse-black",
    syntaxHighlighting: true,
  });
  await initializeShiki("vitesse-black");

  const rendered = renderWithShiki("const value = 1;", "typescript")?.[0] ?? "";
  assert.match(rendered, /\x1b\[38;2;139;148;158m/);
  assert.doesNotMatch(rendered, /\x1b\[38;2;68;68;68m/);
});

test("session disposal interrupts language loading and disposes losing/current highlighters", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "theme-b",
    syntaxHighlighting: true,
  });
  let resolveA: ((value: ShikiHighlighter) => void) | undefined;
  let resolveB: ((value: ShikiHighlighter) => void) | undefined;
  const pendingA = new Promise<ShikiHighlighter>((resolve) => {
    resolveA = resolve;
  });
  const pendingB = new Promise<ShikiHighlighter>((resolve) => {
    resolveB = resolve;
  });
  let disposedA = 0;
  let disposedB = 0;
  let languageStarted: (() => void) | undefined;
  const languagePending = new Promise<void>((resolve) => {
    languageStarted = resolve;
  });
  let languageInterrupted = 0;
  const adapter = ShikiAdapter.of({
    create: (theme) => Effect.promise(() => (theme === "theme-a" ? pendingA : pendingB)),
    loadLanguage: () =>
      Effect.sync(() => languageStarted?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => languageInterrupted++)),
      ),
  });
  const dependencies = Layer.merge(nodeFilePlatformLayer, Layer.succeed(ShikiAdapter, adapter));
  const layer = CodePreviewSession.layer.pipe(Layer.provideMerge(dependencies));
  const runtime = makeCodePreviewRuntime({} as ExtensionAPI, layer);
  setActiveCodePreviewRuntime(runtime as never);
  setActivePlatformRunner({
    run: (effect, signal) => runtime.run(effect, signal),
    runShiki: (effect, signal) => runtime.run(effect, signal),
    forkShiki: (effect) => runtime.fork(effect),
  });

  const first = initializeShiki("theme-a");
  const second = initializeShiki("theme-b");
  resolveB?.(fakeHighlighter(() => disposedB++));
  await second;
  resolveA?.(fakeHighlighter(() => disposedA++));
  await first;
  assert.equal(disposedA, 1);
  assert.equal(disposedB, 0);

  let invalidations = 0;
  renderWithShiki("print('owned')", "python", () => invalidations++);
  await languagePending;
  await runtime.dispose();
  setActiveCodePreviewRuntime(undefined);
  setActivePlatformRunner(undefined);
  assert.equal(languageInterrupted, 1);
  assert.equal(disposedB, 1);
  assert.equal(invalidations, 0);
  assert.equal(getShikiStatus().pendingLanguages, 0);
  assert.equal(getShikiStatus().initialized, false);
});

test("session disposal interrupts an in-flight highlighter creation", async () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    shikiTheme: "pending-theme",
    syntaxHighlighting: true,
  });
  let started: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interrupted = 0;
  const adapter = ShikiAdapter.of({
    create: () =>
      Effect.sync(() => started?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => interrupted++)),
      ),
    loadLanguage: () => Effect.void,
  });
  const dependencies = Layer.merge(nodeFilePlatformLayer, Layer.succeed(ShikiAdapter, adapter));
  const layer = CodePreviewSession.layer.pipe(Layer.provideMerge(dependencies));
  const runtime = makeCodePreviewRuntime({} as ExtensionAPI, layer);
  setActiveCodePreviewRuntime(runtime as never);
  setActivePlatformRunner({
    run: (effect, signal) => runtime.run(effect, signal),
    runShiki: (effect, signal) => runtime.run(effect, signal),
    forkShiki: (effect) => runtime.fork(effect),
  });
  const initialization = initializeShiki("pending-theme");
  await pending;
  await runtime.dispose();
  await assert.rejects(initialization);
  setActiveCodePreviewRuntime(undefined);
  setActivePlatformRunner(undefined);
  assert.equal(interrupted, 1);
  assert.equal(getShikiStatus().initialized, false);
});
