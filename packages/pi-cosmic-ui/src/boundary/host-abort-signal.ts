import * as Predicate from "effect/Predicate";
import { captureHostSignal } from "pi-cosmic-core/host-session";

export const capturedHostSignal = (
  ctx: Parameters<typeof captureHostSignal>[0],
): AbortSignal | undefined => {
  const captured = captureHostSignal(ctx);
  return Predicate.isTagged(captured, "Captured") ? captured.signal : undefined;
};
