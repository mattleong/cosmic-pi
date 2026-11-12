import * as Effect from "effect/Effect";

/** `Effect.provide` for tests, which build complete Layers at the test entry point. */
export const provideBuiltLayer = Effect.provide;
export {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeCapturedTracer,
  makeLifecycleProbe,
  makeInMemoryDocuments,
  streamingHttpResponse,
  streamingHttpTestLayer,
  type InMemoryDocuments,
  type StreamingHttpTestRequest,
} from "./src/testing/layers.ts";
export {
  extensionApiFixture,
  extensionContextFixture,
  type ExtensionContextOverrides,
  type ExtensionHostContext,
} from "./src/testing/host.ts";
export {
  modelFixture,
  modelRegistryFixture,
  type HostModel,
  type HostModelRegistry,
} from "./src/testing/model.ts";
export { failingTheme, plainTheme } from "./src/testing/theme.ts";
export {
  footerDataFixture,
  keybindingsFixture,
  terminalFixture,
  tuiFixture,
  type HostTui,
} from "./src/testing/tui.ts";
export { deferredPromise } from "./src/testing/deferred.ts";
export { keybindingHintsFixture, piKeybindingsFixture } from "./src/testing/pi-keybindings.ts";
export { recordingExtensionHost, type RecordedHandlers } from "./src/testing/extension-host.ts";
export type {
  DefaultedEventName,
  ExtensionEventName,
  ExtensionEventNamed,
} from "./src/testing/extension-events.ts";
export { spawnIpcChild, temporaryDirectory } from "./src/testing/ipc-child.ts";
export { yieldUntil } from "./src/testing/polling.ts";
export { reusedProcessIdentity } from "./src/testing/process.ts";
export { NodeChildProcess } from "./src/platform/node-builtins.ts";
export { eventLoopTurn, macrotask, maybe, settle, step } from "./src/testing/steps.ts";
export { interruptingScheduler, pausedScheduler } from "./src/testing/scheduler.ts";
export { toolSchemaPortabilityProblems } from "./src/testing/tool-schema.ts";
