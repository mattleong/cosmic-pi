import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentContextMode, SubagentRuntime } from "../domain/routing.ts";
import type { BackendDriver, BackendPreflightRequest } from "./model.ts";

export interface BackendSelection {
  readonly runtime: SubagentRuntime;
  readonly context: SubagentContextMode;
}

export interface SubagentBackendRegistryContract {
  readonly resolve: (
    selection: BackendSelection,
  ) => Effect.Effect<BackendDriver, InvalidSubagentRequestError>;
  readonly preflight: (
    selection: BackendSelection,
    request: BackendPreflightRequest,
  ) => Effect.Effect<BackendDriver, InvalidSubagentRequestError>;
}

export const backendRegistryFor = (
  drivers: ReadonlyArray<BackendDriver>,
): SubagentBackendRegistryContract => {
  const byRuntime = new Map<SubagentRuntime, BackendDriver>(
    drivers.map((driver) => [driver.runtime, driver]),
  );
  const resolve: SubagentBackendRegistryContract["resolve"] = (selection) => {
    const driver = byRuntime.get(selection.runtime);
    if (!driver)
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "backend_not_implemented",
          message: `local/${selection.runtime} is configured but has no registered pi-subagents driver.`,
        }),
      );
    if (!driver.supportsContext(selection.context))
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "context_unsupported",
          message: `local/${selection.runtime} does not support ${selection.context} context.`,
        }),
      );
    return Effect.succeed(driver);
  };
  return {
    resolve,
    preflight: (selection, request) =>
      resolve(selection).pipe(Effect.tap((driver) => driver.preflight(request))),
  };
};

export class SubagentBackendRegistry extends Context.Service<
  SubagentBackendRegistry,
  SubagentBackendRegistryContract
>()("pi-subagents/backend/service/SubagentBackendRegistry") {}
