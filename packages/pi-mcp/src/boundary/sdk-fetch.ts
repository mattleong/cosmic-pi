import type { FetchLike, RequestId } from "@modelcontextprotocol/client";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { captureSdkHttpChallenge } from "./sdk-http-challenge.ts";
import { makeSseBudget } from "./mcp-protocol/shared/sse-budget.ts";

/** This header is an internal correlation key and must never reach an MCP server. */
export const SDK_OPERATION_HEADER = "x-pi-mcp-operation";

export class SdkFetchResponseLimitError extends Schema.TaggedError<SdkFetchResponseLimitError>()(
  "SdkFetchResponseLimitError",
  {},
) {
  override readonly message = "MCP response exceeds its byte limit.";
}

export class SdkFetchRedirectError extends Schema.TaggedError<SdkFetchRedirectError>()(
  "SdkFetchRedirectError",
  {},
) {
  override readonly message = "MCP operation redirects are not allowed.";
}

export class SdkFetchBodyError extends Schema.TaggedError<SdkFetchBodyError>()(
  "SdkFetchBodyError",
  {},
) {
  override readonly message = "MCP response body could not be read.";
}

export type SdkFetchFailure =
  | SdkFetchResponseLimitError
  | SdkFetchRedirectError
  | SdkFetchBodyError;

/** Synchronous native callback ingress; Effect owns the cleanup wait and deadline. */
export interface SdkFetchOwner {
  readonly signal: AbortSignal;
  readonly fetchStarted: () => void;
  readonly fetchFinished: () => void;
  readonly bodyStarted: () => void;
  readonly bodyFinished: () => void;
}

export interface SdkFetchOperation extends SdkFetchOwner {
  readonly fail: (error: SdkFetchFailure) => void;
}

export interface SdkFetchOptions {
  readonly maxBytes: number;
  readonly fetch: FetchLike;
  /** Counts every fetch and body, including SDK GET, DELETE, and notification traffic. */
  readonly session: SdkFetchOwner;
  /** Returns an admitted control owner with its initial fetch lease already held. */
  readonly beginControl: () => SdkFetchOwner;
  readonly lookupOperation: (requestId: RequestId) => SdkFetchOperation | undefined;
  /** Exact native POST context also owns SDK cancellation-notification cleanup. */
  readonly currentOperation?: () => SdkFetchOperation | undefined;
  readonly isObservationRequest?: (method: string) => boolean;
  readonly onObservationFailure?: () => void;
  readonly onResponse?: (status: number, requestHeaders: Headers) => void;
}

const decodeRequestId = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      // Replies may reuse an outbound request ID but never own that request's signal.
      method: Schema.String,
      id: Schema.Union([Schema.String, Schema.Finite.check(Schema.isInt())]),
    }),
  ),
);

const requestFromBody = (body: BodyInit | null | undefined) => {
  if (!Predicate.isString(body)) return undefined;
  const decoded = decodeRequestId(body);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const stripInternalHeaders = (headers: HeadersInit | undefined): Headers => {
  const result = new Headers(headers);
  result.delete(SDK_OPERATION_HEADER);
  return result;
};

const contentLength = (response: Response): number | undefined => {
  const value = response.headers.get("content-length")?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};

const aborted = (): Error => new DOMException("MCP request was cancelled.", "AbortError");

/** A rejected cancellation is not cleanup confirmation. Keep its owner's lease. */
const discardBody = (body: ReadableStream<Uint8Array>, finished: () => void): void => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    finished();
  };
  try {
    const reader = body.getReader();
    // A correlated failure can abort the fetch before discard acquires its reader.
    // An already-errored source is settled; a rejecting cancel hook alone is not.
    void reader.closed.catch(finish);
    void reader.cancel().then(finish, () => undefined);
  } catch {
    // A locked or hostile body remains cleanup-unconfirmed until the Effect deadline.
  }
};

const makeBoundedBody = (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  finished: () => void,
  failed: (error: SdkFetchFailure) => void,
  sse: boolean,
  ended: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  const withinSseBudget = makeSseBudget(maxBytes);
  let bytes = 0;
  let sourceFinished = false;
  let terminal = false;
  let cancelling = false;
  let consumer: ReadableStreamDefaultController<Uint8Array>;

  const finish = () => {
    if (sourceFinished) return;
    sourceFinished = true;
    signal.removeEventListener("abort", onAbort);
    finished();
  };
  // An upstream abort may error the source before our abort listener calls cancel.
  // reader.closed rejection confirms that errored source. By contrast, cancelling
  // a readable source fulfills reader.closed before its cancel hook has settled.
  void reader.closed.catch(finish);
  const cancelReader = () => {
    if (cancelling || sourceFinished) return;
    cancelling = true;
    // Do not await this from pull/cancel: a foreign source may never settle. The
    // consumer settles now; Effect separately joins the source within its budget.
    // Retain source ownership when cancellation cannot be confirmed.
    invokeHostCallback(() => void reader.cancel().then(finish, () => undefined), undefined);
  };
  const errorConsumer = (error: Error) => {
    if (terminal) return;
    terminal = true;
    consumer.error(error);
  };
  const onAbort = () => {
    errorConsumer(aborted());
    cancelReader();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      consumer = controller;
    },
    pull(controller) {
      if (terminal) return;
      return reader.read().then(
        (result) => {
          if (terminal) return;
          if (result.done) {
            terminal = true;
            finish();
            ended();
            controller.close();
            return;
          }
          if (!sse) bytes += result.value.byteLength;
          if (sse ? !withinSseBudget(result.value) : bytes > maxBytes) {
            const error = new SdkFetchResponseLimitError();
            failed(error);
            errorConsumer(error);
            cancelReader();
            return;
          }
          controller.enqueue(result.value);
        },
        () => {
          if (terminal) return;
          const error = new SdkFetchBodyError();
          failed(error);
          errorConsumer(error);
          finish();
        },
      );
    },
    cancel() {
      terminal = true;
      cancelReader();
    },
  });

  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return stream;
};

/** SDK owns framing/parsing. This door owns signals, bytes, and source cleanup. */
export const makeSdkFetch = (options: SdkFetchOptions): FetchLike => {
  return (url, init) =>
    Promise.resolve().then(() => {
      const request = requestFromBody(init?.body);
      const method = (init?.method ?? "GET").toUpperCase();
      const operation =
        method !== "POST"
          ? undefined
          : request === undefined
            ? options.currentOperation?.()
            : options.lookupOperation(request.id);
      const observation =
        method === "GET" ||
        (request !== undefined && options.isObservationRequest?.(request.method) === true);
      if (options.session.signal.aborted || init?.signal?.aborted || operation?.signal.aborted) {
        throw aborted();
      }
      const control = operation === undefined && !observation ? options.beginControl() : undefined;
      const owner = operation ?? control;
      const owners: ReadonlyArray<SdkFetchOwner> =
        owner === undefined ? [options.session] : [owner, options.session];
      const signal = AbortSignal.any([
        ...owners.map((owner) => owner.signal),
        ...(init?.signal == null ? [] : [init.signal]),
      ]);
      const sanitizedInit: RequestInit = {
        ...init,
        signal,
        headers: stripInternalHeaders(init?.headers),
        redirect: "error",
      };
      if (signal.aborted) {
        control?.fetchFinished();
        throw aborted();
      }
      // Control admission already holds its fetch lease before the scoped watcher starts.
      for (const owner of owners) {
        if (owner !== control) owner.fetchStarted();
      }
      const finished = () => {
        for (const owner of owners) owner.bodyFinished();
      };
      const observationFailed = () => {
        if (observation && !signal.aborted) options.onObservationFailure?.();
      };
      const failed = (error: SdkFetchFailure) => {
        operation?.fail(error);
        observationFailed();
      };

      // The public FetchLike seam may throw synchronously. Its settlement callback
      // retains ownership even after the Effect caller has stopped waiting.
      return Promise.resolve()
        .then(() => {
          if (signal.aborted) throw aborted();
          return options.fetch(url, sanitizedInit);
        })
        .then(
          (response) => {
            // No observer may see zero resources between headers and body/discard ownership.
            if (response.body !== null) {
              for (const owner of owners) owner.bodyStarted();
            }
            for (const owner of owners) owner.fetchFinished();

            const rejectResponse = (error: Error): never => {
              if (response.body !== null) discardBody(response.body, finished);
              throw error;
            };
            if (signal.aborted) return rejectResponse(aborted());
            if (response.redirected || response.type === "opaqueredirect") {
              const error = new SdkFetchRedirectError();
              failed(error);
              return rejectResponse(error);
            }
            options.onResponse?.(response.status, new Headers(sanitizedInit.headers));
            const sse =
              response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
              "text/event-stream";
            // A missing optional GET route is not an expired session. Some stateless
            // servers return 404 rather than 405; a session-bearing 404 still fails.
            // Auth/outage responses and successful non-SSE GETs lose observation.
            const optionalGetAbsent =
              method === "GET" &&
              (response.status === 405 ||
                (response.status === 404 &&
                  !new Headers(sanitizedInit.headers).has("mcp-session-id")));
            if (
              operation === undefined &&
              observation &&
              !optionalGetAbsent &&
              (response.status >= 400 || (method === "GET" && (!sse || response.body === null)))
            )
              observationFailed();
            const declaredLength = contentLength(response);
            if (!sse && declaredLength !== undefined && declaredLength > options.maxBytes) {
              const error = new SdkFetchResponseLimitError();
              failed(error);
              return rejectResponse(error);
            }
            if (operation !== undefined && init?.method?.toUpperCase() === "POST") {
              captureSdkHttpChallenge(operation, response);
            }
            if (response.body === null) return response;

            let boundedBody: ReadableStream<Uint8Array> | undefined;
            try {
              boundedBody = makeBoundedBody(
                response.body,
                options.maxBytes,
                signal,
                finished,
                failed,
                sse,
                () => {
                  if (sse) observationFailed();
                },
              );
              return new Response(boundedBody, {
                headers: response.headers,
                status: response.status,
                statusText: response.statusText,
              });
            } catch {
              const error = new SdkFetchBodyError();
              failed(error);
              if (boundedBody !== undefined) {
                // The wrapper owns the reader and releases only after source cancellation.
                void boundedBody.cancel().catch(() => undefined);
                throw error;
              }
              return rejectResponse(error);
            }
          },
          () => {
            for (const owner of owners) owner.fetchFinished();
            observationFailed();
            throw signal.aborted ? aborted() : new SdkFetchBodyError();
          },
        );
    });
};
