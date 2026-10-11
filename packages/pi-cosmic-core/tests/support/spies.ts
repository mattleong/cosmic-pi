import * as Effect from "effect/Effect";
import { vi } from "vitest";

const scopedSpy = <Spy extends { readonly mockRestore: () => void }>(make: () => Spy) =>
  Effect.acquireRelease(Effect.sync(make), (spy) => Effect.sync(() => spy.mockRestore()));

export const silencedConsole = Effect.gen(function* () {
  const log = yield* scopedSpy(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
  const error = yield* scopedSpy(() =>
    vi.spyOn(console, "error").mockImplementation(() => undefined),
  );
  return () => log.mock.calls.length + error.mock.calls.length;
});
