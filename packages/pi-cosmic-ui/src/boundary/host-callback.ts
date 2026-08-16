import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export type HostCallbackOperation =
  | "host-query"
  | "protocol-upsert"
  | "protocol-remove"
  | "protocol-invalidate"
  | "request-render"
  | "surface-attach"
  | "surface-detach"
  | "surface-invalidate"
  | "surface-dispose"
  | "surface-render"
  | "footer-render"
  | "footer-install"
  | "footer-remove"
  | "working-message"
  | "branch-unsubscribe"
  | "event-unsubscribe"
  | "notify";

export interface HostCallbackDiagnostic {
  readonly operation: HostCallbackOperation;
}

export interface HostCallbackBoundaryContract {
  /** Invokes a hostile synchronous host/extension callback without exposing its error or data. */
  readonly invoke: <A>(operation: HostCallbackOperation, callback: () => A, fallback: A) => A;
  readonly diagnostics: () => readonly HostCallbackDiagnostic[];
}

export interface HostAbortSignalSnapshot {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
  readonly release: () => void;
}

export class HostCallbackBoundary extends Context.Service<
  HostCallbackBoundary,
  HostCallbackBoundaryContract
>()("pi-cosmic-ui/boundary/host-callback/HostCallbackBoundary") {
  static layer(service: HostCallbackBoundaryContract) {
    return Layer.succeed(this, service);
  }
}

/** Creates the single synchronous callback boundary shared by pre-session and session code. */
export function makeHostCallbackBoundary(maxDiagnostics = 32): HostCallbackBoundaryContract {
  const capacity = Math.max(1, Math.floor(maxDiagnostics));
  const failures: HostCallbackDiagnostic[] = [];
  const record = (operation: HostCallbackOperation) => {
    if (failures.length === capacity) failures.shift();
    failures.push(Object.freeze({ operation }));
  };
  return {
    invoke: (operation, callback, fallback) => {
      try {
        return callback();
      } catch {
        record(operation);
        return fallback;
      }
    },
    diagnostics: () => Object.freeze([...failures]),
  };
}

/** Owns a native abort forwarder so capture-to-registration races cannot lose a host abort. */
export function snapshotHostAbortSignal(
  callbacks: HostCallbackBoundaryContract,
  read: () => AbortSignal | undefined,
): HostAbortSignalSnapshot | undefined {
  return callbacks.invoke<HostAbortSignalSnapshot | undefined>(
    "host-query",
    () => {
      const source = read();
      if (!source)
        return Object.freeze({ signal: undefined, aborted: false, release: () => undefined });
      const controller = new AbortController();
      const forward = () => controller.abort();
      let registered = true;
      const release = () => {
        if (!registered) return;
        registered = false;
        callbacks.invoke(
          "host-query",
          () => source.removeEventListener("abort", forward),
          undefined,
        );
      };
      try {
        source.addEventListener("abort", forward, { once: true });
        if (source.aborted) controller.abort();
      } catch (error) {
        release();
        throw error;
      }
      return Object.freeze({
        signal: controller.signal,
        aborted: controller.signal.aborted,
        release,
      });
    },
    undefined,
  );
}
