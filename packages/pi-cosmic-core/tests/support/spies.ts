import * as Effect from "effect/Effect";
import { vi } from "vitest";

/** Installs a Vitest spy for the current scope and restores it when the scope closes. */
export const scopedSpy = <Spy extends { readonly mockRestore: () => void }>(make: () => Spy) =>
  Effect.acquireRelease(Effect.sync(make), (spy) => Effect.sync(() => spy.mockRestore()));

/** Silences console output for the current scope and reports how many calls reached it. */
export const silencedConsole = Effect.gen(function* () {
  const log = yield* scopedSpy(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
  const error = yield* scopedSpy(() =>
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  );
  return () => log.mock.calls.length + error.mock.calls.length;
});
