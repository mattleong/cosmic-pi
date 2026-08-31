import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { captureHostSignal, invokeHostCallback } from "pi-cosmic-core";

/** Best-effort Effect adapter for synchronous Pi UI callbacks. */
export const ignoreHostUi = <Result>(callback: () => Result) =>
  Effect.sync(() => {
    invokeHostCallback<Result | undefined>(callback, undefined);
  });

/** Best-effort adapter for Pi callbacks that cannot enter the session runtime. */
export function safeHostUi<Result>(callback: () => Result): void {
  invokeHostCallback(callback, undefined);
}

/** Materializes Pi's dynamic cancellation signal without allowing a host getter to defect. */
export function safeHostSignal(ctx: ExtensionContext): AbortSignal | undefined {
  const captured = captureHostSignal(ctx);
  return captured._tag === "Captured" ? captured.signal : undefined;
}
