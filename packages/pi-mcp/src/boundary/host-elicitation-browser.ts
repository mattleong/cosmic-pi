import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { safeElicitationUrl } from "../interaction/form.ts";

/** The URL enters the system browser only after owned Ask User consent and authority checks. */
export const makeElicitationBrowser = (pi: Pick<ExtensionAPI, "exec">) => {
  let opening = false;
  return (url: string, checkCurrent: Effect.Effect<void, McpBoundaryError>) =>
    Effect.gen(function* () {
      yield* checkCurrent;
      if (opening || process.platform !== "darwin" || !safeElicitationUrl(url)) return false;
      const result = yield* Effect.tryPromise({
        try: (signal) => {
          if (signal.aborted || opening) return Promise.resolve(false);
          opening = true;
          let task: ReturnType<ExtensionAPI["exec"]>;
          try {
            task = pi.exec("/usr/bin/open", [url], { signal, timeout: 10_000 });
          } catch {
            opening = false;
            return Promise.resolve(false);
          }
          // Keep native admission until settlement even when the Effect waiter is interrupted.
          return task
            .then(
              (result) => result.code === 0 && !result.killed,
              () => false,
            )
            .finally(() => {
              opening = false;
            });
        },
        catch: () => boundaryError("unavailable", "unknown", "MCP browser handoff failed."),
      });
      yield* checkCurrent;
      return result;
    });
};
