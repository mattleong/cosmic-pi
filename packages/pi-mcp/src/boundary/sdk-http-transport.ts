import {
  Client,
  isJSONRPCRequest,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/client";
import type { NativeContext } from "pi-cosmic-core";
import { observeHttpLog, type SdkHttpLogScope } from "./sdk-http-observations.ts";
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
  type SdkFetchOwner,
  type SdkFetchFailure,
} from "./sdk-fetch.ts";
import type { SdkHttpControl } from "./sdk-http-control.ts";
import { mapSdkClientError } from "./sdk-protocol-error.ts";
import { boundedSdkCleanup } from "./mcp-protocol/shared/bounded-cleanup.ts";
import { isSdkNegotiationRejected } from "./mcp-protocol/shared/negotiation-error.ts";
import {
  beginSdkHttpChallenge,
  sdkHttpChallengeStatus,
  withSdkHttpChallenge,
} from "./sdk-http-challenge.ts";

export class SdkHttpTransportOperationError extends Schema.TaggedError<SdkHttpTransportOperationError>()(
  "SdkHttpTransportOperationError",
  {},
) {
  override readonly message = "MCP operation ownership is no longer active.";
}

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

  reserveSend = (): void => {
    this.resources += 1;
  };

  fetchStarted = (): void => {
    this.started = true;
    this.resources += 1;
  };

  bodyStarted = this.fetchStarted;
  fetchFinished = (): void => this.releaseResource();
  bodyFinished = this.fetchFinished;

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
export class SdkHttpOperation extends SdkHttpTraffic {
  readonly tag: string;
  logScope: SdkHttpLogScope | undefined;
  private response = false;
  private firstFailure: SdkFetchFailure | undefined;
  private readonly failureWaiters = new Set<(error: SdkFetchFailure) => void>();
  private readonly bindId: (operation: SdkHttpOperation, requestId: RequestId) => void;

  constructor(tag: string, bindId: (operation: SdkHttpOperation, requestId: RequestId) => void) {
    super();
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

/** Registry scope is per connection, so a tag from another connection cannot bind here. */
export class SdkHttpOperationRegistry {
  readonly traffic = new SdkHttpTraffic();
  private readonly byTag = new Map<string, SdkHttpOperation>();
  private readonly byRequestId = new Map<RequestId, SdkHttpOperation>();
  private nextOperation = 1;
  private admissionsOpen = true;

  private readonly context: NativeContext<SdkHttpOperation> | undefined;
  constructor(context?: NativeContext<SdkHttpOperation>) {
    this.context = context;
  }

  current = (): SdkHttpOperation | undefined => this.context?.current();
  run = <A>(operation: SdkHttpOperation, callback: () => A): A =>
    this.context ? this.context.run(operation, callback) : callback();

  begin(): SdkHttpOperation | undefined {
    if (!this.admissionsOpen) return undefined;
    const tag = `g1:o${this.nextOperation++}`;
    const operation = new SdkHttpOperation(tag, (owner, requestId) =>
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

  remove(operation: SdkHttpOperation): void {
    if (this.byTag.get(operation.tag) === operation) this.byTag.delete(operation.tag);
    for (const [key, value] of this.byRequestId) {
      if (value === operation) this.byRequestId.delete(key);
    }
  }

  active(): ReadonlyArray<SdkHttpOperation> {
    return [...this.byTag.values()];
  }

  lookupTag = (tag: string): SdkHttpOperation | undefined => this.byTag.get(tag);

  lookupRequestId = (requestId: RequestId): SdkHttpOperation | undefined =>
    this.byRequestId.get(requestId);
}

const requestOutcome = (operation: SdkHttpOperation): McpBoundaryError["outcome"] =>
  operation.responseReceivedValue ? "completed" : operation.requestStarted ? "unknown" : "not-sent";

export const mapSdkFailure = (error: Error, operation: SdkHttpOperation): McpBoundaryError => {
  const outcome = requestOutcome(operation);
  error = operation.failure ?? error;
  if (isSdkNegotiationRejected(error)) {
    return boundaryError(
      "protocol",
      outcome,
      "MCP protocol negotiation was rejected.",
      "protocol-negotiation-rejected",
    );
  }
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
  if (
    (error instanceof SdkHttpError && error.status === 403) ||
    (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpForbidden)
  ) {
    // A bare 403 can be an ACL or proxy denial, not rejected credentials.
    return boundaryError("denied", outcome, "MCP server denied this operation.");
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication) {
    return withSdkHttpChallenge(
      error,
      operation,
      boundaryError("auth-required", outcome, "MCP server requires authentication."),
    );
  }
  const mapped = mapSdkClientError(error, outcome, "MCP connection is unavailable.");
  if (mapped !== undefined) return mapped;
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
  terminate: () => Promise<void> = () => transport.terminateSession(),
): Effect.Effect<void, McpBoundaryError> =>
  Effect.gen(function* () {
    const operations = registry.active();
    registry.closeAdmissions();
    for (const operation of operations) operation.abort();
    const cleanupFailure = () =>
      boundaryError("cleanup", "unknown", "MCP transport cleanup failed.");
    const bounded = <A>(run: () => PromiseLike<A>) =>
      boundedSdkCleanup(run, cleanupTimeoutMs, cleanupFailure()).pipe(Effect.result);

    // DELETE needs a live transport signal. Regardless of its result, revoke all
    // fetch admission and close the client. SDK continuations arriving late then
    // receive an aborted signal without starting another network operation.
    const terminated = yield* bounded(terminate);
    registry.traffic.abort();
    const closed = yield* bounded(() =>
      Promise.allSettled([client.close(), transport.close()]).then((settled) => {
        if (settled.some((result) => result.status === "rejected")) throw cleanupFailure();
      }),
    );
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

/**
 * Decorate the public SDK Transport seam. Legacy SDK requests do not forward their
 * caller signal as requestSignal, so this adapter binds the private tag to the SDK's
 * request id and supplies the operation signal to every HTTP send. It never stores a
 * current request. Each request carries its own tag.
 */
export const makeSdkHttpTransport = (
  transport: Transport,
  registry: SdkHttpOperationRegistry,
  acquisition: () => SdkHttpOperation | undefined = () => undefined,
): Transport => {
  const decorated: Transport = {
    get sessionId() {
      return transport.sessionId;
    },
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => transport.setSupportedProtocolVersions?.(versions),
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) => {
      // Capture ownership and reserve native send before any Promise turn can race cleanup.
      const tag = privateHeader(options?.headers);
      const operation =
        tag === undefined ? (registry.current() ?? acquisition()) : registry.lookupTag(tag);
      if (operation?.signal.aborted) return Promise.reject(new SdkHttpTransportOperationError());
      if (operation) {
        if (isJSONRPCRequest(message)) operation.bindRequestId(message.id);
        operation.reserveSend();
      }
      return Promise.resolve()
        .then(() => {
          if (tag !== undefined && (operation === undefined || operation.signal.aborted)) {
            throw new SdkHttpTransportOperationError();
          }
          const requestSignal = mergeSignals(options?.requestSignal, operation?.signal);
          const headers = withoutPrivateHeader(options?.headers);
          const settleChallenge =
            operation === undefined ? undefined : beginSdkHttpChallenge(operation);
          return Promise.resolve()
            .then(() => {
              const send = () =>
                options === undefined && requestSignal === undefined && headers === undefined
                  ? transport.send(message)
                  : transport.send(message, { ...options, requestSignal, headers });
              return operation ? registry.run(operation, send) : send();
            })
            .then(
              () => settleChallenge?.(),
              (error) => {
                settleChallenge?.(Predicate.isError(error) ? error : undefined);
                throw error;
              },
            );
        })
        .finally(() => operation?.fetchFinished());
    },
  };

  transport.onclose = () => decorated.onclose?.();
  transport.onerror = (error) => decorated.onerror?.(error);
  transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    const operation = registry.current();
    if (operation && !operation.signal.aborted && !operation.responseReceivedValue)
      observeHttpLog(message, operation.logScope);
    if (!isJSONRPCRequest(message) && "id" in message && message.id !== undefined)
      registry.lookupRequestId(message.id)?.responseReceived();
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
