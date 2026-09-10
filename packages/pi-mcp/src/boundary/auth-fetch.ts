import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeSynchronousIngress, NetworkAddresses, pinnedNetworkLookup } from "pi-cosmic-core";
import {
  deniedAuth,
  validateAuthAddresses,
  validateAuthUrl,
  type AuthUrlPolicy,
} from "../auth/policy.ts";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";

export const AUTH_HTTP_LIMITS = {
  maximumBytes: 128 * 1024,
  timeoutMs: 15_000,
  redirects: 3,
} as const;
const unavailable = () => boundaryError("unavailable", "not-sent", "OAuth HTTP request failed.");
interface FetchJob {
  readonly url: string;
  readonly init: RequestInit;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: McpBoundaryError) => void;
}

const aborted = (signal: AbortSignal | null | undefined) =>
  Effect.callback<never, McpBoundaryError>((resume) => {
    if (!signal) return;
    const cancel = () =>
      resume(
        Effect.fail(boundaryError("cancelled", "not-sent", "OAuth HTTP request was cancelled.")),
      );
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });

/** Public Effect Node HTTP client, with connection DNS pinned to the validated set. */
const request = (
  policy: AuthUrlPolicy,
  job: FetchJob,
  redirects = 0,
): Effect.Effect<Response, McpBoundaryError, NetworkAddresses> =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* validateAuthUrl(job.url, policy);
      const network = yield* NetworkAddresses;
      const addresses = yield* network.resolve(url.hostname).pipe(Effect.mapError(unavailable));
      yield* validateAuthAddresses(url, addresses, policy);
      const method = job.init.method?.toUpperCase() ?? "GET";
      if (method !== "GET" && method !== "POST") return yield* deniedAuth();
      const headers = yield* Effect.try({
        try: () => new Headers(job.init.headers),
        catch: deniedAuth,
      });
      if (
        [...headers.keys()].some(
          (key) => !["accept", "content-type", "mcp-protocol-version"].includes(key),
        )
      )
        return yield* deniedAuth();
      const body = job.init.body;
      if (
        body !== undefined &&
        body !== null &&
        !Predicate.isString(body) &&
        !(body instanceof URLSearchParams)
      )
        return yield* deniedAuth();
      const text = body?.toString();
      if (text && new TextEncoder().encode(text).length > AUTH_HTTP_LIMITS.maximumBytes)
        return yield* deniedAuth();
      const agent = yield* NodeHttpClient.makeAgent({
        lookup: pinnedNetworkLookup(url.hostname, addresses),
        keepAlive: false,
      });
      const client = yield* NodeHttpClient.makeNodeHttp.pipe(
        Effect.provideService(NodeHttpClient.HttpAgent, agent),
      );
      let outgoing = HttpClientRequest.make(method)(url, { headers: Object.fromEntries(headers) });
      if (text !== undefined)
        outgoing = HttpClientRequest.bodyText(
          outgoing,
          text,
          headers.get("content-type") ?? "application/x-www-form-urlencoded",
        );
      const response = yield* client.execute(outgoing).pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(unavailable),
      );
      if (response.status >= 300 && response.status < 400) {
        if (
          method !== "GET" ||
          redirects >= AUTH_HTTP_LIMITS.redirects ||
          !response.headers.location
        )
          return yield* deniedAuth();
        const target = yield* Effect.try({
          try: () => new URL(response.headers.location!, url).href,
          catch: deniedAuth,
        });
        return yield* request(policy, { ...job, url: target }, redirects + 1);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            bytes += chunk.length;
            if (bytes > AUTH_HTTP_LIMITS.maximumBytes)
              return Effect.fail(
                boundaryError(
                  "output-limit",
                  "not-sent",
                  "OAuth response exceeded its byte limit.",
                ),
              );
            chunks.push(chunk);
            return Effect.void;
          }),
        ),
        Effect.mapError((error) => (error instanceof McpBoundaryError ? error : unavailable())),
      );
      const content = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      return yield* Effect.try({
        try: () =>
          new Response([204, 205, 304].includes(response.status) ? null : content, {
            status: response.status,
            headers: response.headers,
          }),
        catch: unavailable,
      });
    }),
  );

/** SDK Promise ingress, not an Effect runner. Every request is owned by this scope. */
export const withAuthFetch = <A>(
  policy: AuthUrlPolicy,
  use: (fetch: FetchLike) => Promise<A>,
): Effect.Effect<A, McpBoundaryError, NetworkAddresses> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = new Set<FetchJob>();
      let closed = false;
      let denied: McpBoundaryError | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          for (const job of pending) job.reject(unavailable());
          pending.clear();
        }),
      );
      const ingress = yield* makeSynchronousIngress({
        capacity: 8,
        overflow: "drop",
        handle: (job: FetchJob) =>
          Effect.raceFirst(request(policy, job), aborted(job.init.signal)).pipe(
            Effect.match({
              onFailure: (error) => {
                denied ??= error;
                pending.delete(job);
                job.reject(error);
              },
              onSuccess: (response) => {
                pending.delete(job);
                job.resolve(response);
              },
            }),
          ),
      }).pipe(Effect.mapError(unavailable));
      const fetch: FetchLike = (url, init = {}) => {
        if (closed || denied || init.signal?.aborted)
          return Promise.reject(denied ?? unavailable());
        // The SDK requires a Promise. Its resolve capability is transferred to the scoped worker.
        const completion = Promise.withResolvers<Response>();
        const job: FetchJob = {
          url: String(url),
          init,
          resolve: completion.resolve,
          reject: completion.reject,
        };
        pending.add(job);
        if (ingress.offer(job) !== "accepted") {
          pending.delete(job);
          completion.reject(unavailable());
        }
        return completion.promise;
      };
      const result = yield* Effect.tryPromise({
        try: () => use(fetch),
        catch: () => denied ?? unavailable(),
      });
      if (denied) return yield* denied;
      return result;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: AUTH_HTTP_LIMITS.timeoutMs,
      orElse: () =>
        Effect.fail(boundaryError("timeout", "not-sent", "OAuth request exceeded its deadline.")),
    }),
  );
