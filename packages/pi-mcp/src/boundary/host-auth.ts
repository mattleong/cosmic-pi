import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { invokeHostCallback, isProjectTrusted } from "pi-cosmic-core";
import type { McpLoginUi } from "../auth/model.ts";
import { isLoopbackHost, parseAuthUrl } from "../auth/policy.ts";
import { boundaryError } from "../client/errors.ts";

export const mcpHasLoginUi = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.hasUI === true && (ctx.mode === "tui" || ctx.mode === "rpc"), false);
const unavailable = () =>
  boundaryError(
    "unavailable",
    "not-sent",
    "MCP authentication requires an interactive user dialog.",
  );
const stale = () => boundaryError("stale", "not-sent", "MCP authentication was revoked.");

/** Stock Pi dialogs support RPC as well as TUI. Callback input never enters a tool result. */
export const makeMcpLoginUi = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  manual: boolean,
  current: () => boolean,
): McpLoginUi => {
  const check = () =>
    Effect.suspend(() => {
      if (!invokeHostCallback(current, false) || !isProjectTrusted(ctx))
        return Effect.fail(stale());
      return mcpHasLoginUi(ctx) ? Effect.void : Effect.fail(unavailable());
    });
  // The SDK auth boundary checks issuer, resource and resolved addresses before handing
  // us this URL. This second check prevents the browser adapter accepting another scheme.
  const browserUrl = (value: string) =>
    parseAuthUrl(value).pipe(
      Effect.filterOrFail(
        (url) =>
          url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname)),
        () => boundaryError("denied", "not-sent", "OAuth browser destination was rejected."),
      ),
    );
  return {
    mode: manual ? "manual" : "local",
    openBrowser: (value) =>
      Effect.gen(function* () {
        yield* check();
        const url = yield* browserUrl(value);
        if (manual) return; // The following user dialog displays the URL on the user's host.
        if (process.platform !== "darwin") return yield* unavailable();
        yield* Effect.tryPromise({
          try: (signal) => pi.exec("/usr/bin/open", [url.href], { signal, timeout: 10_000 }),
          catch: unavailable,
        }).pipe(Effect.filterOrFail((result) => result.code === 0 && !result.killed, unavailable));
        yield* check();
      }),
    readCallback: (value) =>
      Effect.gen(function* () {
        yield* check();
        const url = yield* browserUrl(value);
        const callback = yield* Effect.tryPromise({
          try: (signal) =>
            ctx.ui.input(
              `Open this authorization URL in your browser, then paste the full callback URL:\n${url.href}`,
              "Full callback URL",
              { signal, timeout: 300_000 },
            ),
          catch: unavailable,
        });
        yield* check();
        if (callback !== undefined && callback.length > 8_192) {
          return yield* boundaryError("invalid-input", "not-sent", "OAuth callback was rejected.");
        }
        return callback;
      }),
  };
};
