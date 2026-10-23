import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pin one admitted operation's signal without evaluating or freezing Pi's other live getters. */
export const withCapturedHostSignal = <Host extends ExtensionContext>(
  ctx: Host,
  signal: Host["signal"],
): Host =>
  new Proxy(ctx, {
    // This transparent typed-host boundary forwards properties; it does not admit unknown data.
    get: (target, property): unknown =>
      property === "signal" ? signal : Reflect.get(target, property, target),
  });
