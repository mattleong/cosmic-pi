import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface ProcessCloseSource {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly once: (event: "close", listener: () => void) => void;
  readonly off: (event: "close", listener: () => void) => void;
}

/** Waits for a Node child close event and always detaches its listener. */
export const awaitProcessClose = (
  child: ProcessCloseSource,
  timeoutMillis: number,
): Effect.Effect<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return Effect.succeed(true);
  return Effect.callback<void>((resume) => {
    const onClose = () => resume(Effect.void);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) resume(Effect.void);
    return Effect.sync(() => {
      child.off("close", onClose);
    });
  }).pipe(Effect.timeoutOption(Math.max(1, timeoutMillis)), Effect.map(Option.isSome));
};
