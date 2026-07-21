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
  | "footer-install"
  | "footer-remove"
  | "branch-unsubscribe"
  | "event-unsubscribe"
  | "notify";

export interface HostCallbackDiagnostic {
  readonly operation: HostCallbackOperation;
}

export interface HostCallbackBoundaryShape {
  /** Invokes a hostile synchronous host/extension callback without exposing its error or data. */
  readonly invoke: <A>(operation: HostCallbackOperation, callback: () => A, fallback: A) => A;
  readonly diagnostics: () => readonly HostCallbackDiagnostic[];
}

export class HostCallbackBoundary extends Context.Service<
  HostCallbackBoundary,
  HostCallbackBoundaryShape
>()("pi-cosmic-ui/boundary/host-callback/HostCallbackBoundary") {
  static layer(service: HostCallbackBoundaryShape) {
    return Layer.succeed(this, service);
  }
}

/** Creates the single synchronous callback boundary shared by pre-session and session code. */
export function makeHostCallbackBoundary(maxDiagnostics = 32): HostCallbackBoundaryShape {
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
