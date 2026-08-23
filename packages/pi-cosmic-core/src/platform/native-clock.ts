// Native clock access is intentionally confined to synchronous Pi render boundaries.
import * as Clock from "effect/Clock";

/** Effect's default clock is wall-clock backed and safe to read outside a fiber. */
const nativeClock = Clock.Clock.defaultValue();

/** Native synchronous clock required by Pi's synchronous render contract. */
export function synchronousNow(): number {
  return nativeClock.currentTimeMillisUnsafe();
}
