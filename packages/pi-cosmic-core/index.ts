import * as Effect from "effect/Effect";

/** Shared Effect-first foundations for cosmic-pi extensions. */
export { PiApi } from "./src/runtime/pi-api.ts";
export {
  makePiManagedRuntime,
  makePiRuntime,
  piHostLoggerLayer,
  type PiManagedRuntime,
} from "./src/runtime/runtime.ts";
export { bestEffortHostBootstrap } from "./src/runtime/host-bootstrap.ts";
export const provideBuiltLayer = Effect.provide;
export {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
  type PiSessionRuntimeSlot,
} from "./src/runtime/session-runtime.ts";
export { notifyListeners } from "./src/coordination/listeners.ts";
export { makeSubscriptionRefresh } from "./src/coordination/subscription-refresh.ts";
export { mergeHeaders } from "./src/http/headers.ts";
export { JsonDocumentError, StreamingHttpError } from "./src/platform/errors.ts";
export { AgentDirectory } from "./src/platform/agent-directory.ts";
export { SafeFile, type SafeFileContract } from "./src/platform/safe-file.ts";
export { decodeUnknownOrUndefined } from "./src/schema/decode.ts";
export { toPiToolOutputSchema } from "./src/schema/tool-output.ts";
export {
  isJsonObject,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonDocumentStoreContract,
  type JsonObject,
  type JsonValue,
} from "./src/platform/json-document.ts";
export {
  abbreviateHomePath,
  formatDisplayPath,
  isStrictlyInsidePathWith,
} from "./src/platform/paths.ts";
export { isInteractiveShellProcessName } from "./src/platform/shell-process-names.ts";
export { JsonHttpClient } from "./src/platform/json-http.ts";
export {
  CrossProcessLock,
  CrossProcessLockError,
  type CrossProcessLease,
  type CrossProcessLockContract,
} from "./src/platform/cross-process-lock.ts";
export {
  decodeTolerantFields,
  type TolerantFieldDiagnostic,
} from "./src/config/tolerant-fields.ts";
export { makeConfigDocumentErrorFactory } from "./src/config/document-ops.ts";
export {
  commitPreferredScope,
  makeScopedConfigStore,
  type ScopedConfigMetadata,
} from "./src/config/scoped-config-store.ts";
export {
  captureHostSignal,
  captureSessionHost,
  hasTerminalUI,
  invokeBestEffort,
  invokeHostCallback,
  isProjectTrusted,
  isUsingOAuthAtHostBoundary,
  notifyAtHostBoundary,
  type CapturedHostSignal,
  type HostNotificationLevel,
} from "./src/host-session.ts";
export {
  registerExtensionCommand,
  type ExtensionCommand,
  type ExtensionSubcommand,
} from "./src/host-command.ts";
export { makeSessionCapabilityProtocol, querySessionCapability } from "./src/session-capability.ts";
export {
  safeTextPrefix,
  safeTextSuffix,
  utf8ByteLength,
  utf8Prefix,
  utf8Suffix,
} from "./src/text.ts";
export {
  clipText,
  countLabel,
  formatBytes,
  formatCost,
  formatDuration,
  formatElapsed,
  formatRelativeAge,
} from "./src/display.ts";
export {
  failureMessage,
  firstLineMessage,
  isAgentGuidance,
  MESSAGE_TEXT_LIMIT,
  quoteText,
  restatesText,
} from "./src/message-text.ts";
export {
  initialUsageProjection,
  withUsageEligibility,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  type UsageEligibilityStatusTexts,
  type UsageProjectionBase,
} from "./src/usage-projection.ts";
export {
  formatUsageDebugReport,
  makeUsageRefreshController,
  timedDiagnosticResult,
  type SubscriptionUsageConfig,
} from "./src/usage-controller.ts";
export { freezeSnapshot, makeFrozenProjection, ProjectionError } from "./src/projection.ts";
export { hasObjectRuntimeType, runtimeTypeName } from "./src/runtime-values.ts";
export {
  makeSynchronousIngress,
  SynchronousIngressError,
} from "./src/coordination/synchronous-ingress.ts";
export { StreamingHttpClient } from "./src/platform/streaming-http.ts";
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
} from "./src/platform/process.ts";
export {
  processGroupSignalError,
  signalProcess,
  signalProcessGroup,
  terminateWindowsProcessTree,
  type ProcessTreeTerminatorSpawn,
  type WindowsProcessTreeTermination,
} from "./src/platform/process-tree.ts";
export { synchronousMonotonicNow, synchronousNow } from "./src/platform/native-clock.ts";
export { synchronousRandomHex, synchronousRandomUuid } from "./src/platform/native-crypto.ts";
export { sha256Text } from "./src/security/sha256.ts";
export { makeTokenVerifier, type TokenVerifier } from "./src/platform/token-verifier.ts";
export {
  extractJwtClaim,
  hasControlCharacter,
  isSensitiveDiagnosticKey,
  redactDiagnosticValue,
  redactedTokenSchema,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripAnsi,
  stripTerminalControls,
} from "./src/security.ts";
export { sanitizeTerminalStyledFragments } from "./src/security/terminal-styled.ts";
export {
  BooleanFromJsonSchema,
  completeSettingsArguments,
  decodeSettingUpdate,
  FiniteNumberFromJsonSchema,
  InvalidSettingError,
  makeUsageSettingDescriptors,
  type SettingsOptionDescriptor,
} from "./src/settings-completion.ts";
export { dispatchSettingsCommand } from "./src/settings-dispatch.ts";
export {
  clampPercent,
  formatPercent,
  formatTimestamp,
  formatTokens,
  formatWindowedUsageLine,
  usedToLeftPercent,
} from "./src/subscription-format.ts";
