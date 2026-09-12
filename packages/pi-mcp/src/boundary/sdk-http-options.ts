import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { McpBoundaryError, boundaryError } from "../client/errors.ts";
import { MCP_BOUNDARY_LIMITS } from "../client/model.ts";
import { SDK_OPERATION_HEADER } from "./sdk-fetch.ts";

export interface SdkHttpOptions {
  readonly protocol?: "auto" | "legacy";
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  /** Explicit test/I/O seam. The eventual model-facing gateway does not accept this. */
  readonly fetch?: FetchLike;
  /** Installed before acquisition; reports full local cleanup, including failed startup. */
  readonly onCleanup?: (confirmed: boolean) => void;
}

export interface SdkHttpSnapshot {
  readonly protocol: "auto" | "legacy";
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly token: string | undefined;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly fetch: FetchLike | undefined;
  readonly onCleanup: ((confirmed: boolean) => void) | undefined;
}

export interface TokenState {
  value: string | undefined;
  readonly headers: Record<string, string>;
}

const MAX_CONNECT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_REQUEST_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_CLEANUP_TIMEOUT_MS = 30 * 1_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export const invalidHttpOptions = () =>
  boundaryError("invalid-input", "not-sent", "Invalid MCP HTTP options.");

const positiveBounded = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number | undefined => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return undefined;
  }
  return value;
};

export const snapshotOptions = (
  options: SdkHttpOptions,
): Effect.Effect<SdkHttpSnapshot, McpBoundaryError> =>
  Effect.try({
    try: () => {
      if (!(options.url instanceof URL)) throw invalidHttpOptions();
      if (
        options.protocol !== undefined &&
        options.protocol !== "auto" &&
        options.protocol !== "legacy"
      )
        throw invalidHttpOptions();
      if (
        (options.url.protocol !== "http:" && options.url.protocol !== "https:") ||
        options.url.username !== "" ||
        options.url.password !== ""
      ) {
        throw invalidHttpOptions();
      }
      if (options.fetch !== undefined && !Predicate.isFunction(options.fetch)) {
        throw invalidHttpOptions();
      }

      const connectTimeoutMs = positiveBounded(
        options.connectTimeoutMs,
        MCP_BOUNDARY_LIMITS.connectTimeoutMs,
        MAX_CONNECT_TIMEOUT_MS,
      );
      const requestTimeoutMs = positiveBounded(
        options.requestTimeoutMs,
        MCP_BOUNDARY_LIMITS.requestTimeoutMs,
        MAX_REQUEST_TIMEOUT_MS,
      );
      const cleanupTimeoutMs = positiveBounded(
        options.cleanupTimeoutMs,
        MCP_BOUNDARY_LIMITS.cleanupTimeoutMs,
        MAX_CLEANUP_TIMEOUT_MS,
      );
      const requestBytes = positiveBounded(
        options.requestBytes,
        MCP_BOUNDARY_LIMITS.requestBytes,
        MAX_MESSAGE_BYTES,
      );
      const responseBytes = positiveBounded(
        options.responseBytes,
        MCP_BOUNDARY_LIMITS.responseBytes,
        MAX_MESSAGE_BYTES,
      );
      if (
        connectTimeoutMs === undefined ||
        requestTimeoutMs === undefined ||
        cleanupTimeoutMs === undefined ||
        requestBytes === undefined ||
        responseBytes === undefined
      ) {
        throw invalidHttpOptions();
      }

      if (options.onCleanup !== undefined && !Predicate.isFunction(options.onCleanup)) {
        throw invalidHttpOptions();
      }
      validateToken(options.token);
      const sourceHeaders = new Headers(options.headers);
      const headers: Record<string, string> = {};
      for (const [name, value] of sourceHeaders.entries()) {
        const lowerName = name.toLowerCase();
        if (lowerName === SDK_OPERATION_HEADER) continue;
        // The SDK's token-only provider is authoritative when a token snapshot exists.
        if (options.token !== undefined && lowerName === "authorization") continue;
        headers[name] = value;
      }
      return Object.freeze({
        protocol: options.protocol ?? "auto",
        url: new URL(options.url.href),
        headers: Object.freeze(headers),
        token: options.token,
        connectTimeoutMs,
        requestTimeoutMs,
        cleanupTimeoutMs,
        requestBytes,
        responseBytes,
        fetch: options.fetch,
        onCleanup: options.onCleanup,
      });
    },
    catch: (error) => (error instanceof McpBoundaryError ? error : invalidHttpOptions()),
  });

export const validateToken = (token: string | undefined): void => {
  if (token === undefined) return;
  if (!Predicate.isString(token) || token.length > 65_536 || /[\r\n\0]/u.test(token)) {
    throw invalidHttpOptions();
  }
};
