import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { localClaudeBackendDriver } from "./backend/local-claude.ts";
import { localCodexBackendDriver } from "./backend/local-codex.ts";
import { localPiBackendDriver } from "./backend/local-pi.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "./backend/service.ts";
import { ChildProcess } from "./boundary/child-process.ts";
import { LocalCliProcess } from "./boundary/local-cli-process.ts";
import { NativeModelCatalog } from "./boundary/native-model-catalog.ts";
import { sweepAbandonedPrivateState } from "./boundary/private-state.ts";
import { pruneReportArchive } from "./boundary/report-archive.ts";
import { SupervisorChannel } from "./boundary/supervisor-channel.ts";
import { WriterLeaseService } from "./boundary/writer-lease.ts";
import { WorkspaceService } from "./workspace/service.ts";
import type { SubagentNotifier } from "./boundary/host-notifier.ts";
import { SubagentConfigStore, subagentConfigStoreLayer } from "./config/store.ts";
import {
  subagentProfileServiceLayer,
  type SubagentProfileLayerOptions,
} from "./profiles/service.ts";
import type { SubagentProjection } from "./run/model.ts";
import { SubagentService, type SubagentServiceOptions } from "./run/service.ts";

const subagentBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  Effect.gen(function* () {
    const children = yield* ChildProcess;
    const localCli = yield* LocalCliProcess;
    const supervisor = yield* SupervisorChannel;
    return backendRegistryFor([
      localPiBackendDriver(children),
      localClaudeBackendDriver(localCli, supervisor),
      localCodexBackendDriver(localCli, supervisor),
    ]);
  }),
);

/** Startup housekeeping runs in the background for the runtime's lifetime and never blocks it. */
const privateStateHousekeepingLayer = (agentDirectory: string) =>
  Layer.effectDiscard(
    Effect.forkScoped(
      sweepAbandonedPrivateState(agentDirectory).pipe(
        Effect.andThen(pruneReportArchive(agentDirectory)),
      ),
    ),
  );

export interface SubagentLayerOptions extends SubagentProfileLayerOptions {
  readonly sessionKey?: string | undefined;
  /** Root session starts sweep private state that crashed or killed sessions left behind. */
  readonly sweepPrivateState?: boolean | undefined;
  readonly publish: (projection: SubagentProjection) => void;
  readonly restoredSessionUsage?: SubagentServiceOptions["restoredSessionUsage"];
  readonly recordSessionUsage?: SubagentServiceOptions["recordSessionUsage"];
  readonly notify: SubagentNotifier;
  readonly proxyHandler: NonNullable<SubagentServiceOptions["proxyHandler"]>;
  readonly questionnaireHandler: NonNullable<SubagentServiceOptions["questionnaireHandler"]>;
}

export const subagentApplicationLayer = (options: SubagentLayerOptions) => {
  const configStore = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
  const profiles = subagentProfileServiceLayer(options).pipe(Layer.provide(configStore));
  const directory = { agentDirectory: options.agentDirectory };
  const backendBoundaries = Layer.mergeAll(
    ChildProcess.layer(directory),
    LocalCliProcess.layer(directory),
    SupervisorChannel.layer(directory),
  );
  const backend = subagentBackendRegistryLayer.pipe(Layer.provide(backendBoundaries));
  const writerLeases = WriterLeaseService.layer(directory);
  const workspaces = WorkspaceService.layer(directory);
  const service = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* SubagentConfigStore;
      const inspection = yield* store.inspect(
        options.cwd,
        options.agentDirectory,
        options.projectTrusted,
      );
      return SubagentService.layer({
        workspaceSourceCwd: options.cwd,
        ...(options.sessionKey && { workspaceOwnerId: options.sessionKey }),
        publish: options.publish,
        restoredSessionUsage: options.restoredSessionUsage,
        recordSessionUsage: options.recordSessionUsage,
        notify: options.notify,
        questionnaireHandler: options.questionnaireHandler,
        writerWorkspaceMode: inspection.config.writerWorkspaceMode,
        workspaceSetup: inspection.config.workspaceSetup,
        proxyHandler: options.proxyHandler,
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(backend, writerLeases, profiles, workspaces, configStore)));
  return Layer.mergeAll(
    service,
    profiles,
    configStore,
    backend,
    NativeModelCatalog.layer(directory),
    CodePreviewSchedulerService.layer,
    options.sweepPrivateState ? privateStateHousekeepingLayer(options.agentDirectory) : Layer.empty,
  );
};

export type SubagentApplicationLayer = ReturnType<typeof subagentApplicationLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
