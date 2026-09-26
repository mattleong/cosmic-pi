import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpBoundaryError, boundaryError } from "../client/errors.ts";
import { SDK_OPERATION_HEADER } from "./sdk-fetch.ts";
import { SdkLimitFields } from "./sdk-lifecycle.ts";

const LimitsSchema = Schema.Struct(SdkLimitFields);

export type SdkHttpOptions = typeof LimitsSchema.Encoded & {
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
  /** Explicit test/I/O seam. The eventual model-facing gateway does not accept this. */
  readonly fetch?: FetchLike;
  /** Installed before acquisition; reports full local cleanup, including failed startup. */
  readonly onCleanup?: (confirmed: boolean) => void;
};

export interface TokenState {
  value: string | undefined;
  readonly headers: Record<string, string>;
}

export const invalidHttpOptions = () =>
  boundaryError("invalid-input", "not-sent", "Invalid MCP HTTP options.");

export const snapshotOptions = (options: SdkHttpOptions) =>
  Effect.try({
    try: () => {
      const limits = Schema.decodeUnknownSync(LimitsSchema)(options);
      if (
        !(options.url instanceof URL) ||
        (options.url.protocol !== "http:" && options.url.protocol !== "https:") ||
        options.url.username !== "" ||
        options.url.password !== "" ||
        (options.fetch !== undefined && !Predicate.isFunction(options.fetch)) ||
        (options.onCleanup !== undefined && !Predicate.isFunction(options.onCleanup))
      ) {
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
        ...limits,
        url: new URL(options.url.href),
        headers: Object.freeze(headers),
        token: options.token,
        fetch: options.fetch,
        onCleanup: options.onCleanup,
      });
    },
    catch: (error) => (error instanceof McpBoundaryError ? error : invalidHttpOptions()),
  });

export type SdkHttpSnapshot = Effect.Success<ReturnType<typeof snapshotOptions>>;

export const validateToken = (token: string | undefined): void => {
  if (token === undefined) return;
  if (!Predicate.isString(token) || token.length > 65_536 || /[\r\n\0]/u.test(token)) {
    throw invalidHttpOptions();
  }
};
