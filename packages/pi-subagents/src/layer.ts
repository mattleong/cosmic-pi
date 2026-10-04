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
  readonly workspaceOwnerId?: string;
  /**
   * Pi session whose resume memory survives /reload and /tree, and whose workflow run records let
   * a restarted Pi resume and announce its runs; absent keeps both local to the activation.
   */
  readonly sessionKey?: string | undefined;
  /** Read live before loading project workflows; defaults to the activation's trust. */
  readonly isProjectTrusted?: (() => boolean) | undefined;
  readonly publish: (projection: SubagentProjection) => void;
  readonly workflowActivity?: WorkflowActivitySink | undefined;
  readonly notify: SubagentNotifier;
  readonly proxyHandler?: SubagentServiceOptions["proxyHandler"] | undefined;
  readonly questionnaireHandler?: SubagentServiceOptions["questionnaireHandler"] | undefined;
}

export const makeSubagentLayer = (options: SubagentLayerOptions) => {
  // The store remains the single persistence door and is exposed for the human settings command.
  const configStore = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
  const profiles = subagentProfileServiceLayer(options).pipe(Layer.provide(configStore));
  const backendBoundaries = Layer.mergeAll(
    ChildProcess.layer({ agentDirectory: options.agentDirectory }),
    LocalCliProcess.layer({ agentDirectory: options.agentDirectory }),
    SupervisorChannel.layer({ agentDirectory: options.agentDirectory }),
  );
  const backend = subagentBackendRegistryLayer.pipe(Layer.provide(backendBoundaries));
  const nativeModelCatalog = NativeModelCatalog.layer({
    agentDirectory: options.agentDirectory,
  });
  const writerLeases = WriterLeaseService.layer({ agentDirectory: options.agentDirectory });
  const workspaces = WorkspaceService.layer({ agentDirectory: options.agentDirectory });
  const serviceOptions: SubagentServiceOptions = {
    workspaceSourceCwd: options.cwd,
    ...(options.workspaceOwnerId && { workspaceOwnerId: options.workspaceOwnerId }),
    publish: options.publish,
    notify: options.notify,
    ...(options.questionnaireHandler && { questionnaireHandler: options.questionnaireHandler }),
  };
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
        ...serviceOptions,
        writerWorkspaceMode: inspection.config.writerWorkspaceMode,
        ...(options.proxyHandler && { proxyHandler: options.proxyHandler }),
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(backend, writerLeases, profiles, workspaces, configStore)));
  const workflowStore = WorkflowStore.layer({
    cwd: options.cwd,
    agentDirectory: options.agentDirectory,
    isProjectTrusted: options.isProjectTrusted ?? (() => options.projectTrusted),
  }).pipe(Layer.provide(SafeFile.layer), Layer.provide(nodeFilePlatformLayer));
  // Built on the subagent service, so its runs are interrupted before that service stops.
  const workflows = WorkflowService.layer({
    ...(options.workflowActivity && { activity: options.workflowActivity }),
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
    nativeModelCatalog,
    CodePreviewSchedulerService.layer,
  );
};

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
