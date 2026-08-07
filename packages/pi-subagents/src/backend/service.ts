import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentContextMode, SubagentHost, SubagentRuntime } from "../run/model.ts";
import type { BackendDriver, BackendPreflightRequest } from "./model.ts";

export interface BackendSelection {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly context: SubagentContextMode;
}

export interface SubagentBackendRegistryShape {
  /** Resolve capability before a run scope or process is owned. Resolution never performs spawn fallback. */
  readonly resolve: (
    selection: BackendSelection,
  ) => Effect.Effect<BackendDriver, InvalidSubagentRequestError>;
  /** Resolve and perform bounded readiness checks without acquiring run/spawn ownership. */
  readonly preflight: (
    selection: BackendSelection,
    request: BackendPreflightRequest,
  ) => Effect.Effect<BackendDriver, InvalidSubagentRequestError>;
}

const driverKey = (host: SubagentHost, runtime: SubagentRuntime): string => `${host}/${runtime}`;

export const makeSubagentBackendRegistry = (
  drivers: ReadonlyArray<BackendDriver>,
): SubagentBackendRegistryShape => {
  const bySelection = new Map(
    drivers.map((driver) => [driverKey(driver.host, driver.runtime), driver]),
  );
  const resolve: SubagentBackendRegistryShape["resolve"] = (selection) => {
    const driver = bySelection.get(driverKey(selection.host, selection.runtime));
    if (!driver)
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "backend_not_implemented",
          message: `${selection.host}/${selection.runtime} is configured but has no registered pi-subagents driver.`,
        }),
      );
    if (!driver.supportsContext(selection.context))
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "context_unsupported",
          message: `${selection.host}/${selection.runtime} does not support ${selection.context} context.`,
        }),
      );
    return Effect.succeed(driver);
  };
  return {
    resolve,
    preflight: (selection, request) =>
      resolve(selection).pipe(
        Effect.flatMap((driver) => driver.preflight(request).pipe(Effect.as(driver))),
      ),
  };
};

export class SubagentBackendRegistry extends Context.Service<
  SubagentBackendRegistry,
  SubagentBackendRegistryShape
>()("pi-subagents/backend/service/SubagentBackendRegistry") {
  static readonly layer = (drivers: ReadonlyArray<BackendDriver>) =>
    Layer.succeed(this, makeSubagentBackendRegistry(drivers));
}
