import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { SafeFile } from "pi-cosmic-core/platform/safe-file";
import { localClaudeBackendDriver } from "./backend/local-claude.ts";
import { localCodexBackendDriver } from "./backend/local-codex.ts";
import { localPiBackendDriver } from "./backend/local-pi.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "./backend/service.ts";
import { ChildProcess } from "./boundary/child-process.ts";
import { LocalCliProcess } from "./boundary/local-cli-process.ts";
import { NativeModelCatalog } from "./boundary/native-model-catalog.ts";
import { sweepAbandonedPrivateState } from "./boundary/private-state.ts";
import { pruneReportArchive, sessionReportArchive } from "./boundary/report-archive.ts";
import { SupervisorChannel } from "./boundary/supervisor-channel.ts";
import { WriterLeaseService } from "./boundary/writer-lease.ts";
import { WorkspaceService } from "./workspace/service.ts";
import type { SubagentNotifier } from "./boundary/host-notifier.ts";
import { subagentConfigStoreLayer } from "./config/store.ts";
import {
  SubagentProfileService,
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
  readonly agentMain?: SubagentServiceOptions["agentMain"];
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
  const service = Layer.unwrap(
    Effect.gen(function* () {
      // The session's base configuration, which the doctor reports and /tree keeps.
      const { baseConfig } = yield* SubagentProfileService.use((session) => session.capture);
      const { hooks } = baseConfig;
      const workspaces = WorkspaceService.layer({
        ...directory,
        worktreeRemove: hooks.WorktreeRemove,
      });
      return SubagentService.layer({
        workspaceSourceCwd: options.cwd,
        ...(options.sessionKey && { workspaceOwnerId: options.sessionKey }),
        publish: options.publish,
        restoredSessionUsage: options.restoredSessionUsage,
        recordSessionUsage: options.recordSessionUsage,
        notify: options.notify,
        ...(options.sessionKey && {
          archiveReport: sessionReportArchive(options.agentDirectory, options.sessionKey),
        }),
        agentMain: options.agentMain,
        questionnaireHandler: options.questionnaireHandler,
        writerWorkspaceMode: baseConfig.writerWorkspaceMode,
        worktreeCreate:
          hooks.invalidWorktreeCreate.length > 0
            ? { invalid: hooks.invalidWorktreeCreate }
            : hooks.WorktreeCreate,
        proxyHandler: options.proxyHandler,
      }).pipe(Layer.provide(workspaces));
    }),
  ).pipe(Layer.provide(Layer.mergeAll(backend, writerLeases, profiles, configStore)));
  return Layer.mergeAll(
    service,
    profiles,
    configStore,
    backend,
    NativeModelCatalog.layer(directory),
    CodePreviewSchedulerService.layer,
    // Doctor reads the checkout's .worktreeinclude the way workspace creation does, and checks
    // that private state is writable.
    SafeFile.layer.pipe(Layer.provideMerge(nodeFilePlatformLayer)),
    options.sweepPrivateState ? privateStateHousekeepingLayer(options.agentDirectory) : Layer.empty,
  );
};

type SubagentApplicationLayer = ReturnType<typeof subagentApplicationLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
