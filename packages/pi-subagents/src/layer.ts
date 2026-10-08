import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { makeLocalClaudeBackendDriver } from "./backend/local-claude.ts";
import { makeLocalCodexBackendDriver } from "./backend/local-codex.ts";
import { makeLocalPiBackendDriver } from "./backend/local-pi.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "./backend/service.ts";
import { ChildProcess } from "./boundary/child-process.ts";
import { LocalCliProcess } from "./boundary/local-cli-process.ts";
import { NativeModelCatalog } from "./boundary/native-model-catalog.ts";
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
import { WorkflowJournal } from "./workflow/journal.ts";
import type { WorkflowActivitySink } from "./workflow/runs.ts";
import type { WorkflowRunObserver } from "./workflow/run-observer.ts";
import { WorkflowService } from "./workflow/service.ts";
import { WorkflowStore } from "./workflow/store.ts";

/** One memoized registry owns the three local drivers and their shared boundary services. */
const subagentBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  Effect.gen(function* () {
    const children = yield* ChildProcess;
    const localCli = yield* LocalCliProcess;
    const supervisor = yield* SupervisorChannel;
    return makeSubagentBackendRegistry([
      makeLocalPiBackendDriver(children),
      makeLocalClaudeBackendDriver(localCli, supervisor),
      makeLocalCodexBackendDriver(localCli, supervisor),
    ]);
  }),
);

export interface SubagentLayerOptions extends SubagentProfileLayerOptions {
  /**
   * Pi session whose resume memory survives /reload and /tree, whose workflow run records let a
   * restarted Pi resume and announce its runs, and which owns its writer workspaces; absent keeps
   * them local to the activation.
   */
  readonly sessionKey?: string | undefined;
  /** Read live before loading project workflows. */
  readonly isProjectTrusted: () => boolean;
  readonly publish: (projection: SubagentProjection) => void;
  readonly workflowActivity: WorkflowActivitySink;
  /** Follows which workflow runs still need the main agent, which keeps workflows available. */
  readonly workflowObserver: WorkflowRunObserver;
  readonly notify: SubagentNotifier;
  readonly proxyHandler: NonNullable<SubagentServiceOptions["proxyHandler"]>;
  readonly questionnaireHandler: NonNullable<SubagentServiceOptions["questionnaireHandler"]>;
}

export const makeSubagentLayer = (options: SubagentLayerOptions) => {
  // The store remains the single persistence door and is exposed for the human settings command.
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
      // Read the persisted mode separately from profile handoffs, which preserve an older route baseline.
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
        notify: options.notify,
        questionnaireHandler: options.questionnaireHandler,
        writerWorkspaceMode: inspection.config.writerWorkspaceMode,
        proxyHandler: options.proxyHandler,
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(backend, writerLeases, profiles, workspaces, configStore)));
  const workflowStore = WorkflowStore.layer({
    cwd: options.cwd,
    agentDirectory: options.agentDirectory,
    isProjectTrusted: options.isProjectTrusted,
  }).pipe(Layer.provide(SafeFile.layer), Layer.provide(nodeFilePlatformLayer));
  // Built on the subagent service, so its runs are interrupted before that service stops.
  const workflows = WorkflowService.layer({
    activity: options.workflowActivity,
    observer: options.workflowObserver,
    notify: options.notify,
    sessionKey: options.sessionKey,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(service, WorkflowJournal.layer(options.sessionKey), workflowStore),
    ),
    Layer.provide(nodeFilePlatformLayer),
  );
  // Layer memoization shares both persistence and the backend registry with host preflight/service use.
  return Layer.mergeAll(
    workflows,
    workflowStore,
    service,
    profiles,
    configStore,
    backend,
    NativeModelCatalog.layer(directory),
    CodePreviewSchedulerService.layer,
  );
};

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
