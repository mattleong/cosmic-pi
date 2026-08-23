/** Shared Effect-first foundations for cosmic-pi extensions. */
export { PiApi } from "./src/runtime/pi-api.ts";
export {
  makePiManagedRuntime,
  makePiRuntime,
  piHostLoggerLayer,
  type PiHostLogTarget,
  type PiManagedRuntime,
} from "./src/runtime/runtime.ts";
export { bestEffortHostBootstrap } from "./src/runtime/host-bootstrap.ts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export const provideBuiltLayer: <ROut, E2, RIn>(
  layer: Layer.Layer<ROut, E2, RIn>,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>> =
  Effect.provide;
export {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiSessionRuntimeHooks,
  type PiSessionRuntimeSlot,
} from "./src/runtime/session-runtime.ts";
export {
  mergeRefreshRequest,
  type RefreshRequest,
} from "./src/coordination/refresh-coordinator.ts";
export {
  makeSubscriptionRefresh,
  type SubscriptionRefresh,
  type SubscriptionRefreshOptions,
} from "./src/coordination/subscription-refresh.ts";
export { JsonDocumentError, JsonHttpError, StreamingHttpError } from "./src/platform/errors.ts";
export { AgentDirectory, AgentDirectoryError } from "./src/platform/agent-directory.ts";
export {
  SafeFile,
  SafeFileError,
  type SafeFileResult,
  type SafeFileContract,
} from "./src/platform/safe-file.ts";
export {
  readSchemaDocument,
  SchemaDocumentError,
  type DecodedDocument,
} from "./src/platform/schema-document.ts";
export {
  type AtomicJsonDocumentStoreContract,
  isJsonObject,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonDocumentStoreContract,
  type JsonObject,
  type JsonValue,
} from "./src/platform/json-document.ts";
export {
  abbreviateHomePath,
  isContainedPath,
  isContainedPathWith,
  isStrictlyInsidePath,
  isStrictlyInsidePathWith,
  type PathContainmentAdapter,
} from "./src/platform/paths.ts";
export {
  JsonHttpClient,
  type JsonHttpAcceptedResponse,
  type JsonHttpClientContract,
  type JsonHttpRejectedResponse,
  type JsonHttpRequest,
  type JsonHttpRequestInput,
  type JsonHttpResponse,
  type JsonHttpResponseSchema,
} from "./src/platform/json-http.ts";
export {
  ProcessCoordinator,
  type ProcessCoordinatorContract,
} from "./src/platform/process-coordinator.ts";
export {
  decodeTolerantFields,
  type TolerantFieldDiagnostic,
  type TolerantFieldOptions,
  type TolerantFieldResult,
  type TolerantFieldSchemas,
  type TolerantFieldValues,
} from "./src/config/tolerant-fields.ts";
export {
  scopedDocumentPaths,
  selectScopedDocument,
  type ScopedDocumentPathOptions,
  type ScopedDocumentPaths,
  type ScopedDocumentSelection,
  type ScopedDocumentSelectionOptions,
} from "./src/config/scoped-store.ts";
export {
  makeConfigDocumentErrorFactory,
  modifyJsonObject,
  readConfigOrWarn,
  readOptionalJsonObject,
  readRawJsonObject,
  writeJsonObject,
  type ConfigDocumentErrorFactory,
} from "./src/config/document-ops.ts";
export {
  makeScopedConfigStore,
  type ScopedConfigMetadata,
  type ScopedConfigStore,
  type ScopedConfigStoreOptions,
} from "./src/config/scoped-config-store.ts";
export {
  captureHostSignal,
  captureSessionHost,
  hasTerminalUI,
  invokeHostCallback,
  isProjectTrusted,
  isUsingOAuthAtHostBoundary,
  notifyAtHostBoundary,
  type CapturedHostSignal,
  type CapturedSessionHost,
  type HostModelRegistry,
  type HostNotificationLevel,
  type HostNotifierContext,
  type HostSessionContext,
  type HostTrustContext,
  type HostUiContext,
} from "./src/host-session.ts";
export {
  initialUsageProjection,
  withUsageEligibility,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  type UsageEligibilityDecision,
  type UsageEligibilityStatusTexts,
  type UsageProjectionBase,
  type UsageVisibilityFields,
} from "./src/usage-projection.ts";
export {
  formatUsageDebugReport,
  makeUsageRefreshController,
  type UsageControllerConfig,
  type UsageControllerConfigFields,
  type UsageControllerStore,
  type UsageDebugReport,
  type UsageFetchOutcome,
  type UsageProviderRequirements,
  type UsageRefreshController,
  type UsageRefreshControllerOptions,
} from "./src/usage-controller.ts";
export {
  createFooterPresenter,
  type FooterHostData,
  type FooterMode,
  type FooterPresenter,
  type FooterPresenterOptions,
  type FooterTheme,
} from "./src/footer-presenter.ts";
export {
  freezeSnapshot,
  makeFrozenProjection,
  ProjectionError,
  type FrozenProjection,
} from "./src/projection.ts";
export {
  hasObjectRuntimeType,
  runtimeTypeName,
  type RuntimeTypeName,
} from "./src/runtime-values.ts";
export {
  makeSynchronousIngress,
  SynchronousIngressError,
  type SynchronousIngress,
  type SynchronousIngressOfferResult,
  type SynchronousIngressOptions,
  type SynchronousIngressOverflow,
} from "./src/coordination/synchronous-ingress.ts";
export {
  StreamingHttpClient,
  type StreamingHttpClientContract,
  type StreamingHttpRequest,
  type StreamingJsonBodyCodec,
  type StreamingHttpResponse,
} from "./src/platform/streaming-http.ts";
export {
  fileLayer as nodeFilePlatformLayer,
  layer as nodePlatformLayer,
} from "./src/platform/node.ts";
export {
  BoundedProcessError,
  confirmEffectProcessClose,
  effectProcessExit,
  nodeProcessLayer,
  provideNodeProcess,
  runBoundedProcess,
  runBoundedProcessNode,
  runBoundedProcessScoped,
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type EffectProcessExit,
} from "./src/platform/process.ts";
export { awaitProcessClose, type ProcessCloseSource } from "./src/platform/process-close.ts";
export { synchronousNow } from "./src/platform/native-clock.ts";
export {
  decodeJwtPayloadText,
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripAnsi,
  stripTerminalControls,
  type DiagnosticSanitizerOptions,
} from "./src/security.ts";
export {
  sanitizeTerminalStyledFragments,
  sanitizeTerminalStyledText,
  type SanitizedTerminalStyledFragment,
  type TerminalStyledFragment,
} from "./src/security/terminal-styled.ts";
export {
  completeSettingsArguments,
  sectionSettingValue,
  type SettingsCompletionChoice,
  type SettingsCompletionDescriptor,
} from "./src/settings-completion.ts";
export {
  dispatchSettingsCommand,
  type SettingsCommandDispatch,
  type SettingsDispatchDescriptor,
} from "./src/settings-dispatch.ts";
export {
  clampPercent,
  formatCompactReset,
  formatPercent,
  formatResetCountdown,
  formatTimestampOrNever,
  formatTokens,
  formatWindowedUsageLine,
  remainingResetSeconds,
  usedToLeftPercent,
  type UsageWindowLine,
} from "./src/subscription-format.ts";
