/** Shared Effect-first foundations for cosmic-pi extensions. */
export { PiApi } from "./src/runtime/pi-api.ts";
export {
  makePiManagedRuntime,
  makePiRuntime,
  piHostLoggerLayer,
  type PiManagedRuntime,
} from "./src/runtime/runtime.ts";
export {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiSessionRuntimeHooks,
  type PiSessionRuntimeSlot,
} from "./src/runtime/session-runtime.ts";
export {
  makeRefreshCoordinator,
  makeRefreshCoordinatorWith,
  mergeRefreshRequest,
  type RefreshCoordinator,
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
  type SafeFileShape,
} from "./src/platform/safe-file.ts";
export {
  decodeSchemaDocument,
  readSchemaDocument,
  SchemaDocumentError,
  updateSchemaDocument,
  type DecodedDocument,
} from "./src/platform/schema-document.ts";
export {
  type AtomicJsonDocumentStoreShape,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonDocumentStoreShape,
  type JsonObject,
} from "./src/platform/json-document.ts";
export {
  JsonHttpClient,
  type JsonHttpAcceptedResponse,
  type JsonHttpClientShape,
  type JsonHttpRejectedResponse,
  type JsonHttpRequest,
  type JsonHttpRequestInput,
  type JsonHttpResponse,
  type JsonHttpResponseSchema,
} from "./src/platform/json-http.ts";
export {
  ProcessCoordinator,
  type ProcessCoordinatorShape,
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
  updateScopedSection,
  type ScopedDocumentPathOptions,
  type ScopedDocumentPaths,
  type ScopedDocumentSelection,
} from "./src/config/scoped-store.ts";
export {
  modifyJsonObject,
  readConfigOrWarn,
  readOptionalJsonObject,
  readRawJsonObject,
  writeJsonObject,
  type ConfigDocumentErrorFactory,
} from "./src/config/document-ops.ts";
export {
  captureHostSignal,
  captureSessionHost,
  hasTerminalUI,
  isProjectTrusted,
  type CapturedHostSignal,
  type CapturedSessionHost,
  type HostSessionContext,
  type HostTrustContext,
  type HostUiContext,
} from "./src/host-session.ts";
export { withUsageEligibility, type UsageVisibilityFields } from "./src/usage-projection.ts";
export {
  freezeSnapshot,
  makeFrozenProjection,
  ProjectionError,
  type FrozenProjection,
} from "./src/projection.ts";
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
  type StreamingHttpClientShape,
  type StreamingHttpRequest,
  type StreamingJsonBodyCodec,
  type StreamingHttpResponse,
} from "./src/platform/streaming-http.ts";
export {
  fileLayer as nodeFilePlatformLayer,
  layer as nodePlatformLayer,
} from "./src/platform/node.ts";
export {
  decodeJwtPayloadText,
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  stripAnsi,
  type DiagnosticSanitizerOptions,
} from "./src/security.ts";
export {
  clampPercent,
  formatCompactReset,
  formatPercent,
  formatResetClock,
  formatResetCountdown,
  formatTokens,
  formatWindowedUsageLine,
  remainingResetSeconds,
  type UsageWindowLine,
} from "./src/subscription-format.ts";
