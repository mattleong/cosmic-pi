import * as Effect from "effect/Effect";

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
export const provideBuiltLayer = Effect.provide;
export {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiSessionRuntimeHooks,
  type PiSessionRuntimeSlot,
} from "./src/runtime/session-runtime.ts";
export { type RefreshRequest } from "./src/coordination/refresh-coordinator.ts";
export {
  makeSubscriptionRefresh,
  type SubscriptionRefresh,
  type SubscriptionRefreshOptions,
} from "./src/coordination/subscription-refresh.ts";
export { mergeHeaders } from "./src/http/headers.ts";
export { JsonDocumentError, StreamingHttpError } from "./src/platform/errors.ts";
export { AgentDirectory } from "./src/platform/agent-directory.ts";
export {
  NetworkAddresses,
  NetworkAddressError,
  pinnedNetworkLookup,
  type NetworkAddress,
  type NetworkAddressesContract,
} from "./src/platform/network-addresses.ts";
export { nodeHttpServerLayer } from "./src/platform/http-server.ts";
export { SafeFile, type SafeFileResult, type SafeFileContract } from "./src/platform/safe-file.ts";
export { readSchemaDocument, type DecodedDocument } from "./src/platform/schema-document.ts";
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
  CrossProcessLock,
  CrossProcessLockError,
  type CrossProcessLease,
  type CrossProcessLockContract,
  type CrossProcessLockOptions,
} from "./src/platform/cross-process-lock.ts";
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
  readConfigOrWarn,
  readOptionalJsonObject,
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
  timedDiagnosticResult,
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
  runBoundedProcessNode,
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type EffectProcessExit,
} from "./src/platform/process.ts";
export { awaitProcessClose, type ProcessCloseSource } from "./src/platform/process-close.ts";
export {
  DUPLEX_PROCESS_DEFAULTS,
  duplexProcessError,
  DuplexProcessError,
  openDuplexProcess,
  type DuplexProcessCleanupState,
  type DuplexProcessExit,
  type DuplexProcessHandle,
  type DuplexProcessOptions,
} from "./src/platform/duplex-process.ts";
export { synchronousNow } from "./src/platform/native-clock.ts";
export {
  decodeJwtPayloadText,
  extractJwtClaim,
  hasControlCharacter,
  maskIdentifier,
  redactDiagnosticValue,
  redactedTokenSchema,
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
  BooleanFromJsonSchema,
  completeSettingsArguments,
  decodeSettingUpdate,
  FiniteNumberFromJsonSchema,
  InvalidSettingError,
  makeUsageSettingDescriptors,
  sectionSettingValue,
  type SettingsCompletionChoice,
  type SettingsCompletionDescriptor,
  type SettingsOptionDescriptor,
} from "./src/settings-completion.ts";
export {
  dispatchSettingsCommand,
  type SettingsCommandDispatch,
  type SettingsDispatchDescriptor,
} from "./src/settings-dispatch.ts";
export {
  clampPercent,
  formatCompactReset,
  formatShortReset,
  formatPercent,
  formatTokens,
  formatWindowedUsageLine,
  remainingResetSeconds,
  usedToLeftPercent,
  type UsageWindowLine,
} from "./src/subscription-format.ts";
