// Test lifecycle boundary intentionally uses Promises and AbortController.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import type { CodePreviewRuntime } from "./index";
import { CodePreviewSession } from "../session-service";
import { defaultCodePreviewSettings, setCodePreviewSettings } from "../settings";
import { codePreviewsWithDependencies, type CodePreviewExtensionDependencies } from "./index";

type Context = {
  cwd: string;
  signal?: AbortSignal;
  isProjectTrusted(): boolean;
  ui: { notify(message: string, level: string): void };
};
type Handler = (event: unknown, ctx: Context) => unknown;

const settings = { ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: [] };
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

function harness(load: (call: number) => Effect.Effect<typeof settings>) {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  let acquisitions = 0;
  let releases = 0;
  let calls = 0;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const dependencies: CodePreviewExtensionDependencies = {
    registerHealth: () => undefined,
    registerSettings: () => undefined,
    registerRenderers: () => undefined,
    makeRuntime: (runtimePi) => {
      const serviceLayer = Layer.effect(
        CodePreviewSession,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions++;
            return CodePreviewSession.of({
              loadSettings: () => load(calls++),
              initializeSyntax: () => Effect.void,
            });
          }),
          () => Effect.sync(() => releases++),
        ),
      );
      return makePiManagedRuntime(runtimePi, serviceLayer) as unknown as CodePreviewRuntime;
    },
  };
  const context = (signal?: AbortSignal): Context => ({
    cwd: "/project",
    ...(signal ? { signal } : {}),
    isProjectTrusted: () => true,
    ui: { notify: (message) => notifications.push(message) },
  });
  return {
    pi,
    handlers,
    dependencies,
    context,
    notifications,
    counts: () => ({ acquisitions, releases, calls }),
  };
}

test("factory registers lifecycle callbacks synchronously without starting a runtime", async () => {
  const h = harness(() => Effect.succeed(settings));
  const registration = codePreviewsWithDependencies(h.pi, h.dependencies);
  assert.equal(h.handlers.has("session_start"), true);
  assert.equal(h.handlers.has("session_shutdown"), true);
  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
  await registration;
});

test("replacement interrupts startup and releases each session exactly once", async () => {
  setCodePreviewSettings(settings);
  let started: (() => void) | undefined;
  let interrupted = 0;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness((call) =>
    call === 0
      ? Effect.sync(() => started?.()).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        )
      : Effect.succeed(settings),
  );
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const first = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  await firstStarted;
  const second = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  await second;
  await first;
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, calls: 2 });
  await h.handlers.get("session_shutdown")?.({}, h.context());
  await h.handlers.get("session_shutdown")?.({}, h.context());
  assert.equal(h.counts().releases, 2);
});

test("abort interrupts pending startup and awaits its finalizer", async () => {
  setCodePreviewSettings(settings);
  let started: (() => void) | undefined;
  let interrupted = 0;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness(() =>
    Effect.sync(() => started?.()).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => interrupted++)),
    ),
  );
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const controller = new AbortController();
  const startup = h.handlers.get("session_start")?.(
    {},
    h.context(controller.signal),
  ) as Promise<void>;
  await pending;
  controller.abort();
  await startup;
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
});

test("startup failure notifies and releases the acquired runtime", async () => {
  setCodePreviewSettings(settings);
  const h = harness(() => Effect.die("settings failed"));
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  await h.handlers.get("session_start")?.({}, h.context());
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});
