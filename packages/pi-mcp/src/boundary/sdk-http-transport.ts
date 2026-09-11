import {
  Client,
  isJSONRPCRequest,
  MissingRequiredClientCapabilityError,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
  SdkError,
  SdkErrorCode,
  ProtocolError,
  SdkHttpError,
  UnauthorizedError,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import {
  SdkFetchBodyError,
  SdkFetchRedirectError,
  SdkFetchResponseLimitError,
  SDK_OPERATION_HEADER,
  type SdkFetchOperation,
  type SdkFetchOwner,
  type SdkFetchFailure,
} from "./sdk-fetch.ts";
import type { SdkHttpControl } from "./sdk-http-control.ts";
import { mapSdkProtocolError } from "./sdk-protocol-error.ts";
import {
  beginSdkHttpChallenge,
  sdkHttpChallengeStatus,
  withSdkHttpChallenge,
} from "./sdk-http-challenge.ts";

export interface SdkHttpTransportOperation extends SdkFetchOperation {
  readonly signal: AbortSignal;
  readonly generation: number;
  readonly tag: string;
  readonly responseReceivedValue: boolean;
  readonly requestStarted: boolean;
  readonly isIdle: boolean;
  readonly bindRequestId: (requestId: RequestId) => void;
  readonly responseReceived: () => void;
  readonly abort: () => void;
  readonly awaitIdle: () => Effect.Effect<void>;
  readonly failure: SdkFetchFailure | undefined;
  readonly awaitFailure: () => Effect.Effect<never, McpBoundaryError>;
}

export interface SdkHttpTransportRegistry {
  readonly lookupTag: (tag: string) => SdkHttpTransportOperation | undefined;
  readonly lookupRequestId: (requestId: RequestId) => SdkHttpTransportOperation | undefined;
}

export class SdkHttpTransportOperationError extends Schema.TaggedError<SdkHttpTransportOperationError>()(
  "SdkHttpTransportOperationError",
  {},
) {
  override readonly message = "MCP operation ownership is no longer active.";
}

const OPERATION_TAG_MAX = 128;

/** Native callbacks update resource leases synchronously; Effect owns their waits. */
export class SdkHttpTraffic implements SdkFetchOwner {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private resources = 0;
  private started = false;
  private readonly waiters = new Set<() => void>();

  get requestStarted(): boolean {
    return this.started;
  }

  get isIdle(): boolean {
    return this.resources === 0;
  }

  fetchStarted = (): void => {
    this.started = true;
    this.resources += 1;
  };

  fetchFinished = (): void => {
    this.releaseResource();
  };

  bodyStarted = (): void => {
    this.started = true;
    this.resources += 1;
  };

  bodyFinished = (): void => {
    this.releaseResource();
  };

  abort = (): void => {
    if (!this.signal.aborted) this.controller.abort();
  };

  awaitIdle = (): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      if (this.resources === 0) {
        resume(Effect.void);
        return;
      }
      const waiter = () => resume(Effect.void);
      this.waiters.add(waiter);
      return Effect.sync(() => {
        this.waiters.delete(waiter);
      });
    });

  private releaseResource(): void {
    if (this.resources === 0) return;
    this.resources -= 1;
    if (this.resources !== 0) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}

/** Failures stay correlated even when the SDK swallows or rewrites stream errors. */
export class SdkHttpOperation extends SdkHttpTraffic implements SdkHttpTransportOperation {
  readonly generation: number;
  readonly tag: string;
  private response = false;
  private firstFailure: SdkFetchFailure | undefined;
  private readonly failureWaiters = new Set<(error: SdkFetchFailure) => void>();
  private readonly bindId: (operation: SdkHttpOperation, requestId: RequestId) => void;

  constructor(
    generation: number,
    tag: string,
    bindId: (operation: SdkHttpOperation, requestId: RequestId) => void,
  ) {
    super();
    this.generation = generation;
    this.tag = tag;
    this.bindId = bindId;
  }

  get responseReceivedValue(): boolean {
    return this.response;
  }

  get failure(): SdkFetchFailure | undefined {
    return this.firstFailure;
  }

  bindRequestId = (requestId: RequestId): void => {
    if (!this.signal.aborted) this.bindId(this, requestId);
  };

  responseReceived = (): void => {
    if (!this.signal.aborted) this.response = true;
  };

  fail = (error: SdkFetchFailure): void => {
    if (this.signal.aborted || this.firstFailure !== undefined) return;
    this.firstFailure = error;
    const waiters = [...this.failureWaiters];
    this.failureWaiters.clear();
    for (const waiter of waiters) waiter(error);
  };

  awaitFailure = (): Effect.Effect<never, McpBoundaryError> =>
    Effect.callback<never, McpBoundaryError>((resume) => {
      const waiter = (error: SdkFetchFailure) => resume(Effect.fail(mapSdkFailure(error, this)));
      if (this.firstFailure !== undefined) {
        waiter(this.firstFailure);
        return;
      }
      this.failureWaiters.add(waiter);
      return Effect.sync(() => {
        this.failureWaiters.delete(waiter);
      });
    });
}

/** Registry scope is per connection, so a tag from an old generation cannot bind here. */
export class SdkHttpOperationRegistry implements SdkHttpTransportRegistry {
  readonly traffic = new SdkHttpTraffic();
  private readonly byTag = new Map<string, SdkHttpOperation>();
  private readonly byRequestId = new Map<RequestId, SdkHttpOperation>();
  private nextOperation = 1;
  private readonly generation: number;
  private admissionsOpen = true;

  constructor(generation: number) {
    this.generation = generation;
  }

  begin(): SdkHttpOperation | undefined {
    if (!this.admissionsOpen) return undefined;
    const id = this.nextOperation;
    this.nextOperation += 1;
    const tag = `g${this.generation}:o${id}`;
    if (tag.length > OPERATION_TAG_MAX) return undefined;
    const operation = new SdkHttpOperation(this.generation, tag, (owner, requestId) =>
      this.bindRequestId(owner, requestId),
    );
    this.byTag.set(tag, operation);
    return operation;
  }

  closeAdmissions(): void {
    this.admissionsOpen = false;
  }

  bindRequestId(operation: SdkHttpOperation, requestId: RequestId): void {
    if (this.byTag.get(operation.tag) !== operation) return;
    this.byRequestId.set(requestId, operation);
  }

  remove(operation: SdkHttpTransportOperation): void {
    if (this.byTag.get(operation.tag) === operation) this.byTag.delete(operation.tag);
    for (const [key, value] of this.byRequestId) {
      if (value === operation) this.byRequestId.delete(key);
    }
  }

  active(): ReadonlyArray<SdkHttpOperation> {
    return [...this.byTag.values()];
  }

  lookupTag = (tag: string): SdkHttpTransportOperation | undefined => this.byTag.get(tag);

  lookupRequestId = (requestId: RequestId): SdkHttpTransportOperation | undefined =>
    this.byRequestId.get(requestId);
}

const requestOutcome = (operation: SdkHttpTransportOperation): McpBoundaryError["outcome"] =>
  operation.responseReceivedValue ? "completed" : operation.requestStarted ? "unknown" : "not-sent";

export const mapSdkFailure = (
  error: Error,
  operation: SdkHttpTransportOperation,
): McpBoundaryError => {
  const outcome = requestOutcome(operation);
  error = operation.failure ?? error;
  if (error instanceof SdkFetchResponseLimitError) {
    return boundaryError("output-limit", outcome, "MCP response exceeds its byte limit.");
  }
  if (error instanceof SdkFetchRedirectError) {
    return boundaryError("transport", outcome, "MCP operation redirects are not allowed.");
  }
  if (error instanceof SdkFetchBodyError) {
    return boundaryError("transport", outcome, "MCP response body could not be read.");
  }
  if (error instanceof SdkHttpTransportOperationError) {
    return boundaryError("unavailable", "not-sent", "MCP operation ownership is no longer active.");
  }
  if (error instanceof InsufficientScopeError) {
    return withSdkHttpChallenge(
      error,
      operation,
      boundaryError(
        "auth-required",
        outcome,
        "MCP server requires permission review.",
        "oauth-insufficient-scope",
      ),
    );
  }
  if (
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401) ||
    // The SDK may throw while parsing a malformed challenge before UnauthorizedError.
    sdkHttpChallengeStatus(error, operation) === 401
  ) {
    return withSdkHttpChallenge(
      error,
      operation,
      boundaryError("auth-required", outcome, "MCP server requires authentication."),
    );
  }
  if (error instanceof SdkHttpError && error.status === 403) {
    return boundaryError("denied", outcome, "MCP server denied this operation.");
  }
  if (
    error instanceof UrlElicitationRequiredError ||
    error instanceof MissingRequiredClientCapabilityError ||
    error instanceof UnsupportedProtocolVersionError
  ) {
    return boundaryError(
      "unsupported",
      outcome,
      "MCP server requires an unsupported interaction, capability, or protocol version.",
    );
  }
  if (error instanceof ProtocolError) return mapSdkProtocolError(error, outcome);
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return boundaryError("timeout", "unknown", "MCP request timed out.");
      case SdkErrorCode.InvalidResult:
      case SdkErrorCode.UnsupportedResultType:
        return boundaryError("protocol", "completed", "MCP returned an invalid result.");
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.NotInitialized:
      case SdkErrorCode.AlreadyConnected:
        return boundaryError("connection", "not-sent", "MCP connection is unavailable.");
      case SdkErrorCode.ClientHttpAuthentication:
        return withSdkHttpChallenge(
          error,
          operation,
          boundaryError("auth-required", outcome, "MCP server requires authentication."),
        );
      case SdkErrorCode.ClientHttpForbidden:
        // A bare 403 can be an ACL or proxy denial, not rejected credentials.
        return boundaryError("denied", outcome, "MCP server denied this operation.");
      default:
        return boundaryError("transport", outcome, "MCP transport request failed.");
    }
  }
  if (error.name === "AbortError") {
    return boundaryError("cancelled", "unknown", "MCP request was cancelled.");
  }
  return boundaryError("transport", outcome, "MCP transport request failed.");
};

export const closeSdkTransport = (
  client: Client,
  transport: StreamableHTTPClientTransport,
  registry: SdkHttpOperationRegistry,
  controls: SdkHttpControl,
  cleanupTimeoutMs: number,
): Effect.Effect<void, McpBoundaryError> =>
  Effect.gen(function* () {
    const operations = registry.active();
    registry.closeAdmissions();
    for (const operation of operations) operation.abort();
    const cleanupFailure = () =>
      boundaryError("cleanup", "unknown", "MCP transport cleanup failed.");
    const bounded = (run: () => Promise<void>) =>
      Effect.tryPromise({ try: run, catch: cleanupFailure }).pipe(
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: Duration.millis(cleanupTimeoutMs),
          orElse: () => Effect.fail(cleanupFailure()),
        }),
        Effect.result,
      );

    // DELETE needs a live transport signal. Regardless of its result, revoke all
    // fetch admission and close the client. SDK continuations arriving late then
    // receive an aborted signal without starting another network operation.
    const terminated = yield* bounded(() => transport.terminateSession());
    registry.traffic.abort();
    const closed = yield* bounded(() => client.close());
    const { idle, controlled, requests } = yield* Effect.all(
      {
        controlled: controls.close.pipe(Effect.result),
        requests: Effect.forEach(operations, (operation) => operation.awaitIdle(), {
          concurrency: "unbounded",
        }).pipe(Effect.interruptible, Effect.timeoutOption(Duration.millis(cleanupTimeoutMs))),
        idle: registry.traffic
          .awaitIdle()
          .pipe(Effect.interruptible, Effect.timeoutOption(Duration.millis(cleanupTimeoutMs))),
      },
      { concurrency: "unbounded" },
    );
    for (const operation of operations) {
      if (operation.isIdle) registry.remove(operation);
    }
    if (
      terminated._tag === "Failure" ||
      closed._tag === "Failure" ||
      controlled._tag === "Failure" ||
      Option.isNone(idle) ||
      Option.isNone(requests)
    ) {
      return yield* Effect.fail(cleanupFailure());
    }
  });

const mergeSignals = (
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined => {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return AbortSignal.any([first, second]);
};

const privateHeader = (
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  if (headers === undefined) return undefined;
  let tag: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== SDK_OPERATION_HEADER) continue;
    if (tag !== undefined && tag !== value) throw new SdkHttpTransportOperationError();
    tag = value;
  }
  return tag;
};

const withoutPrivateHeader = (
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (headers === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== SDK_OPERATION_HEADER) result[name] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
};

const bindRequestIds = (
  message: JSONRPCMessage | ReadonlyArray<JSONRPCMessage>,
  operation: SdkHttpTransportOperation,
): void => {
  const messages = Array.isArray(message) ? message : [message];
  for (const candidate of messages) {
    if (isJSONRPCRequest(candidate)) operation.bindRequestId(candidate.id);
  }
};

const markResponses = (
  message: JSONRPCMessage | ReadonlyArray<JSONRPCMessage>,
  registry: SdkHttpTransportRegistry,
): void => {
  const messages = Array.isArray(message) ? message : [message];
  for (const candidate of messages) {
    if (!isJSONRPCRequest(candidate) && "id" in candidate) {
      registry.lookupRequestId(candidate.id)?.responseReceived();
    }
  }
};

/**
 * Decorate the public SDK Transport seam. Legacy SDK requests do not forward their
 * caller signal as requestSignal, so this adapter binds the private tag to the SDK's
 * request id and supplies the operation signal to every HTTP send. It never stores a
 * current request. Each request carries its own tag and generation.
 */
export const makeSdkHttpTransport = (
  transport: Transport,
  registry: SdkHttpTransportRegistry,
): Transport => {
  const decorated: Transport = {
    get sessionId() {
      return transport.sessionId;
    },
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => transport.setSupportedProtocolVersions?.(versions),
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) =>
      Promise.resolve().then(() => {
        const tag = privateHeader(options?.headers);
        const operation = tag === undefined ? undefined : registry.lookupTag(tag);
        if (tag !== undefined && (operation === undefined || operation.signal.aborted)) {
          throw new SdkHttpTransportOperationError();
        }
        if (operation !== undefined) bindRequestIds(message, operation);
        const requestSignal = mergeSignals(options?.requestSignal, operation?.signal);
        const headers = withoutPrivateHeader(options?.headers);
        const settleChallenge =
          operation === undefined ? undefined : beginSdkHttpChallenge(operation);
        return Promise.resolve()
          .then(() =>
            options === undefined && requestSignal === undefined && headers === undefined
              ? transport.send(message)
              : transport.send(message, { ...options, requestSignal, headers }),
          )
          .then(
            () => settleChallenge?.(),
            (error) => {
              settleChallenge?.(Predicate.isError(error) ? error : undefined);
              throw error;
            },
          );
      }),
  };

  transport.onclose = () => decorated.onclose?.();
  transport.onerror = (error) => decorated.onerror?.(error);
  transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    markResponses(message, registry);
    decorated.onmessage?.(message, extra);
  };
  if (transport.hasPerRequestStream === true) {
    Object.defineProperty(decorated, "hasPerRequestStream", {
      configurable: false,
      enumerable: true,
      value: true,
      writable: false,
    });
  }
  return decorated;
};
