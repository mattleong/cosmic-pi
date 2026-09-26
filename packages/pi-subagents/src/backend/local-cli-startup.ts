import * as Effect from "effect/Effect";
import type { LocalCliProcessContract, LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { SupervisorChannelContract } from "../boundary/supervisor-channel.ts";
import { withLocalSupervisorInstructions } from "./local-supervisor-prompt.ts";
import type { BackendLaunchRequest } from "./model.ts";
import { supervisorError } from "./driver-shared.ts";

/** Shared acquisition only; native initialization and event lifecycles belong to each driver. */
export const startLocalCli = (
  runtime: LocalCliRuntime,
  request: BackendLaunchRequest,
  processes: LocalCliProcessContract,
  supervisors: SupervisorChannelContract,
) =>
  Effect.gen(function* () {
    const launch = withLocalSupervisorInstructions(request);
    const supervisor = yield* Effect.mapError(
      supervisors.open({ runId: request.runId }),
      supervisorError("open supervisor channel"),
    );
    const child = yield* processes.spawn({ runtime, launch, supervisor: supervisor.metadata });
    return { launch, child, supervisor };
  });
