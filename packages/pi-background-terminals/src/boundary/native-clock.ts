// Pi render callbacks are synchronous and cannot yield Effect's Clock service.
// @effect-diagnostics effect/globalDate:off
/** Native synchronous clock required by Pi's synchronous render contract. */
export function synchronousNow(): number {
  return Date.now();
}
