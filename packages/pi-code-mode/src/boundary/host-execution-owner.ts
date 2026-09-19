import * as Effect from "effect/Effect";

/** Activation-owned cancellation, separate from the settings runtime. */
export function makeHostExecutionOwner() {
  const controller = new AbortController();
  return {
    current: () => !controller.signal.aborted,
    revoke: () => controller.abort(),
    run: <A>(
      effect: Effect.Effect<A>,
      caller: AbortSignal | undefined,
      run: (effect: Effect.Effect<A>, signal: AbortSignal) => Promise<A>,
    ): Promise<A> => {
      const linked = new AbortController();
      const abort = () => linked.abort();
      const sources = caller ? [controller.signal, caller] : [controller.signal];
      const release = () => {
        for (const source of sources) {
          try {
            source.removeEventListener("abort", abort);
          } catch {
            // A hostile caller signal cannot prevent owned listener cleanup.
          }
        }
      };
      for (const source of sources) {
        try {
          source.addEventListener("abort", abort, { once: true });
          if (source.aborted) abort();
        } catch {
          abort();
        }
      }
      // The pinned runner starts evaluating before installing its signal listener.
      // Refuse already-revoked work inside the Effect as well as forwarding interruption.
      return Promise.resolve()
        .then(() =>
          run(
            Effect.suspend(() => (linked.signal.aborted ? Effect.interrupt : effect)),
            linked.signal,
          ),
        )
        .finally(release);
    },
  };
}

export type HostExecutionOwner = ReturnType<typeof makeHostExecutionOwner>;
