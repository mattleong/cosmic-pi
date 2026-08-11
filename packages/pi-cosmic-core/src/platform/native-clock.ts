// Native clock access is intentionally confined to synchronous Pi render boundaries.
// @effect-diagnostics effect/globalDate:off
/** Native synchronous clock required by Pi's synchronous render contract. */
export function synchronousNow(): number {
  return Date.now();
}
