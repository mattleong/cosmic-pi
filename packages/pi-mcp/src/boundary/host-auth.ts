import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
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
const browserFailed = () =>
  boundaryError(
    "unavailable",
    "not-sent",
    "OAuth browser could not be opened.",
    "oauth-browser-open-failed",
  );
const expired = () =>
  boundaryError(
    "timeout",
    "not-sent",
    "OAuth callback exceeded its deadline.",
    "oauth-callback-timeout",
  );
const remaining = (deadline: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      now < deadline ? Effect.succeed(Math.max(1, deadline - now)) : Effect.fail(expired()),
    ),
  );

/** Stock Pi dialogs support RPC as well as TUI. Callback input never enters a tool result. */
export const makeMcpLoginUi = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  manual: boolean,
  current: () => boolean,
): McpLoginUi => {
  let nativeOpening = false;
  const browserBusy = boundaryError(
    "busy",
    "not-sent",
    "A browser-open request is still settling.",
  );
  const revoked = stale();
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
  const ui: McpLoginUi = {
    mode: manual ? "manual" : "local",
    openBrowser: (value, mayOpen) =>
      Effect.gen(function* () {
        yield* check();
        const url = yield* browserUrl(value);
        if (manual) return; // The following user dialog displays the URL on the user's host.
        if (process.platform !== "darwin") return yield* browserFailed();
        yield* Effect.tryPromise({
          try: (signal) => {
            if (
              !invokeHostCallback(
                () =>
                  (!mayOpen || mayOpen()) &&
                  current() &&
                  isProjectTrusted(ctx) &&
                  mcpHasLoginUi(ctx),
                false,
              )
            )
              return Promise.reject(revoked);
            if (nativeOpening) return Promise.reject(browserBusy);
            nativeOpening = true;
            try {
              // Interruption aborts the request but does not prove native settlement.
              // Keep this private latch until the original Promise actually completes.
              return pi
                .exec("/usr/bin/open", [url.href], { signal, timeout: 10_000 })
                .finally(() => {
                  nativeOpening = false;
                });
            } catch {
              nativeOpening = false;
              return Promise.reject(browserFailed());
            }
          },
          catch: (error) =>
            error === browserBusy ? browserBusy : error === revoked ? revoked : browserFailed(),
        }).pipe(
          Effect.filterOrFail((result) => result.code === 0 && !result.killed, browserFailed),
        );
        yield* check();
      }),
    readCallback: (value, applicableDeadline) =>
      Effect.gen(function* () {
        yield* check();
        const url = yield* browserUrl(value);
        const deadline = applicableDeadline ?? (yield* Clock.currentTimeMillis) + 180_000;
        const displayTimeout = yield* remaining(deadline);
        // Pi publishes only prompt titles through ui_prompt_start. The URL belongs
        // solely to the stock user dialog's private message field, including RPC.
        const confirmed = yield* Effect.tryPromise({
          try: (signal) =>
            ctx.ui.confirm(
              "MCP sign-in: open browser",
              `Open this authorization URL in your browser. Continue when ready to paste the full callback URL.\n${url.href}`,
              { signal, timeout: displayTimeout },
            ),
          catch: unavailable,
        });
        yield* check();
        const inputTimeout = yield* remaining(deadline);
        if (!confirmed) return undefined;
        const callback = yield* Effect.tryPromise({
          try: (signal) =>
            ctx.ui.input("MCP sign-in: callback", "Full callback URL", {
              signal,
              timeout: inputTimeout,
            }),
          catch: unavailable,
        });
        yield* check();
        yield* remaining(deadline);
        if (callback !== undefined && callback.length > 8_192) {
          return yield* boundaryError("invalid-input", "not-sent", "OAuth callback was rejected.");
        }
        return callback;
      }),
  };
  if (!manual && invokeHostCallback(() => ctx.mode === "rpc", false)) {
    const nextAction: NonNullable<McpLoginUi["nextAction"]> = (deadline, failedOpen) =>
      Effect.gen(function* () {
        yield* check();
        const timeout = yield* remaining(deadline);
        const action = yield* Effect.tryPromise({
          try: (signal) =>
            ctx.ui.select(
              failedOpen
                ? "MCP sign-in: browser did not open"
                : "MCP sign-in: waiting for browser approval",
              ["Reopen browser", "Cancel sign-in"],
              { signal, timeout },
            ),
          catch: unavailable,
        });
        yield* check();
        yield* remaining(deadline);
        return action === "Reopen browser" ? "reopen" : "cancel";
      });
    Object.assign(ui, { nextAction });
  }
  return ui;
};
