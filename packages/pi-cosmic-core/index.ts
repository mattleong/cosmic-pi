/** Shared Effect-first foundations for cosmic-pi extensions. */
export { PiApi } from "./src/pi-api.ts";
export { makePiManagedRuntime, makePiRuntime, type PiManagedRuntime } from "./src/runtime.ts";
export {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiSessionRuntimeHooks,
  type PiSessionRuntimeSlot,
} from "./src/session-runtime.ts";
export {
  makeRefreshCoordinator,
  makeRefreshCoordinatorWith,
  mergeRefreshRequest,
  type RefreshCoordinator,
  type RefreshRequest,
} from "./src/refresh-coordinator.ts";
export {
  makeSubscriptionRefresh,
  type SubscriptionRefresh,
  type SubscriptionRefreshOptions,
} from "./src/subscription-refresh.ts";
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
} from "./src/config/scoped-repository.ts";
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
} from "./src/synchronous-ingress.ts";
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
  sanitizeDiagnosticError,
  stripAnsi,
  type DiagnosticSanitizerOptions,
} from "./src/security.ts";
export {
  formatCompactReset,
  formatResetClock,
  formatResetCountdown,
} from "./src/subscription-format.ts";
