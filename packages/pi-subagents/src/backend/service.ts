import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentContextMode } from "../domain/routing.ts";
import type { BackendDriver, BackendPreflightRequest } from "./model.ts";

interface BackendSelection {
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

export const backendRegistryFor = (driver: BackendDriver): SubagentBackendRegistryContract => {
  const resolve: SubagentBackendRegistryContract["resolve"] = (selection) =>
    driver.supportsContext(selection.context)
      ? Effect.succeed(driver)
      : Effect.fail(
          InvalidSubagentRequestError.make({
            code: "context_unsupported",
            message: `Subagents do not support ${selection.context} context.`,
          }),
        );
  return {
    resolve,
    preflight: (selection, request) =>
      resolve(selection).pipe(Effect.tap((resolved) => resolved.preflight(request))),
  };
};

export class SubagentBackendRegistry extends Context.Service<
  SubagentBackendRegistry,
  SubagentBackendRegistryContract
>()("pi-subagents/backend/service/SubagentBackendRegistry") {}
