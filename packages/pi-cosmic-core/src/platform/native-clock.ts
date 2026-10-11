import * as Clock from "effect/Clock";

const nativeClock = Clock.Clock.defaultValue();

export function synchronousNow(): number {
  return nativeClock.currentTimeMillisUnsafe();
}

export function synchronousMonotonicNow(): number {
  return Number(nativeClock.monotonicTimeNanosUnsafe()) / 1_000_000;
}
