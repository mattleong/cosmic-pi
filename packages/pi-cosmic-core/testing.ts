export {
  capturedTelemetrySnapshot,
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  makeCapturedLogger,
  makeCapturedTracer,
  makeLifecycleProbe,
  makeInMemoryDocuments,
  streamingHttpResponse,
  streamingHttpTestLayer,
  type InMemoryDocuments,
  type JsonHttpTestResponse,
  type StreamingHttpTestRequest,
} from "./src/testing/layers.ts";
export {
  extensionApiFixture,
  extensionContextFixture,
  type ExtensionContextOverrides,
  type ExtensionHostContext,
} from "./src/testing/host.ts";
export { extensionUiFixture } from "./src/testing/ui.ts";
export { sessionManagerFixture, type HostSessionManager } from "./src/testing/session.ts";
export {
  modelFixture,
  modelRegistryFixture,
  type HostModel,
  type HostModelRegistry,
} from "./src/testing/model.ts";
export { failingTheme, PlainTheme, plainTheme, themeFixture } from "./src/testing/theme.ts";
export {
  footerDataFixture,
  keybindingsFixture,
  overlayHandleFixture,
  terminalFixture,
  tuiFixture,
  type HostComponent,
  type HostFooterData,
  type HostKeybindings,
  type HostOverlayHandle,
  type HostTerminal,
  type HostTui,
} from "./src/testing/tui.ts";
export { deferredPromise } from "./src/testing/deferred.ts";
export { piKeybindingsFixture } from "./src/testing/pi-keybindings.ts";
export {
  recordingExtensionHost,
  type RecordedEmit,
  type RecordedHandlers,
} from "./src/testing/extension-host.ts";
export type {
  DefaultedEventName,
  ExtensionEventName,
  ExtensionEventNamed,
  ExtensionEventResult,
  RecordedHandler,
} from "./src/testing/extension-events.ts";
export { galleryDirectory, writeGallerySection } from "./src/testing/gallery.ts";
export { spawnIpcChild, temporaryDirectory } from "./src/testing/ipc-child.ts";
export { yieldUntil } from "./src/testing/polling.ts";
export { reusedProcessIdentity } from "./src/testing/process.ts";
export { eventLoopTurn, macrotask, maybe, settle, step } from "./src/testing/steps.ts";
export { interruptingScheduler, pausedScheduler } from "./src/testing/scheduler.ts";
export { toolSchemaPortabilityProblems } from "./src/testing/tool-schema.ts";
