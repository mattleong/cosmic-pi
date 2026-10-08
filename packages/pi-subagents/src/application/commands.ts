// Pi command handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { discoverActivityView } from "pi-cosmic-ui/activity/view";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import { NativeModelCatalog } from "../boundary/native-model-catalog.ts";
import { SubagentConfigStore, type SubagentConfigStoreContract } from "../config/store.ts";
import type { SubagentApplication } from "../layer.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionFeaturePatch, SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../settings/controller.ts";
import { isPendingDeliveryError } from "../tools/outcome.ts";
import type { FleetMessageDelivery } from "../ui/fleet.ts";
import { registerUltracodeCommand } from "../ultracode/command.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { UltracodeController } from "./ultracode.ts";
import { isUltracodeWindowOpen } from "./ultracode-window.ts";

/** The facts about the session's current activation that commands act on. */
export interface CommandActivation {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly sessionKey?: string | undefined;
}

export interface ApplicationCommandHost {
  readonly bridge: SubagentProjectionBridge;
  readonly ultracode: UltracodeController;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentApplication>,
    signal?: AbortSignal,
  ) => Promise<A>;
  /** The activation the runtime serves now, or undefined while none is active. */
  readonly current: () => CommandActivation | undefined;
  readonly isActive: () => boolean;
}

/**
 * Registers `/subagents` and `/ultracode` over the session's runtime. An action that outlives the
 * activation it started in fails instead of reporting into the session that replaced it.
 */
export function registerApplicationCommands(pi: ExtensionAPI, host: ApplicationCommandHost): void {
  const { bridge, ultracode, run, current, isActive } = host;
  const withCurrentActivation = <A>(
    operation: (activation: CommandActivation) => Promise<A>,
  ): Promise<A> => {
    const activation = current();
    return activation
      ? operation(activation).then((result) => {
          if (current() !== activation) throw new Error("Subagents session was replaced.");
          return result;
        })
      : Promise.reject(new Error("Subagents are not active; run /reload and try again."));
  };

  const runCurrent = <A, E>(effect: Effect.Effect<A, E, SubagentApplication>): Promise<A> =>
    withCurrentActivation(() => run(effect));
  /** Runs a run-registry action whose result the caller doesn't read. */
  const runAction = <E>(
    act: (service: SubagentServiceContract) => Effect.Effect<unknown, E>,
  ): Promise<void> => run(SubagentService.use(act).pipe(Effect.asVoid));

  const withConfigStore =
    <Patch, A, E>(
      select: (
        store: SubagentConfigStoreContract,
      ) => (cwd: string, agentDirectory: string, patch: Patch) => Effect.Effect<A, E>,
    ) =>
    (patch: Patch): Promise<A> =>
      withCurrentActivation((activation) =>
        run(
          SubagentConfigStore.use((store) =>
            select(store)(activation.cwd, activation.agentDirectory, patch),
          ),
        ),
      );

  /** Applies a session switch, then tells the ultracode controller the session's new value. */
  const applySessionFeature = (
    patchFor: (snapshot: SessionProfileSnapshot) => SessionFeaturePatch,
  ): Promise<void> =>
    runCurrent(
      Effect.gen(function* () {
        const profiles = yield* SubagentProfileService;
        return yield* profiles.patchSessionFeature(patchFor(yield* profiles.capture));
      }),
    ).then((snapshot) => ultracode.setEnabled(snapshot.effectiveConfig.ultracode));

  const managerActions: FleetManagerActions = {
    openActivity: (signal) => {
      const activation = current();
      if (!activation || !isActive() || signal?.aborted)
        return Promise.reject(new Error("Subagents aren't available in this session"));
      const capability = activation.sessionKey
        ? discoverActivityView(pi.events, activation.sessionKey)
        : undefined;
      return Promise.resolve(capability ? capability.open("subagents", signal) : false).then(
        (opened) => {
          if (current() !== activation || !isActive() || signal?.aborted)
            throw new Error("Subagents session was replaced");
          return opened;
        },
      );
    },
    isAvailable: () => current() !== undefined,
    captureModelRefresh: () => {
      const activation = current();
      const isCurrent = () => activation !== undefined && current() === activation;
      return {
        isCurrent,
        run: (effect, signal) =>
          isCurrent()
            ? run(effect, signal)
            : Promise.reject(new Error("Subagents session was replaced.")),
      };
    },
    stop: (id) => runAction((service) => service.stop(id)),
    interrupt: (id) => runAction((service) => service.interrupt(id)),
    resume: (id, message) => runAction((service) => service.resume(id, message)),
    send: (id, message) =>
      run(
        SubagentService.use((service) =>
          service.send(id, message).pipe(
            Effect.as<FleetMessageDelivery>("delivered"),
            // Backend-owned pending guidance is neither delivered nor failed; only that exact
            // typed disposition resolves. Generic uncertainty and failures still reject.
            Effect.catchIf(isPendingDeliveryError, () =>
              Effect.succeed<FleetMessageDelivery>("pending"),
            ),
          ),
        ),
      ),
    reply: (id, message) => runAction((service) => service.reply(id, message)),
    rename: (id, name) => runAction((service) => service.rename(id, name)),
    inspectProfiles: (projectTrusted) =>
      withCurrentActivation((activation) =>
        run(
          Effect.gen(function* () {
            const store = yield* SubagentConfigStore;
            const profiles = yield* SubagentProfileService;
            const persistent = yield* store.inspect(
              activation.cwd,
              activation.agentDirectory,
              projectTrusted,
            );
            const session = yield* profiles.capture;
            return { ...persistent, session };
          }),
        ),
      ),
    inspectWriterWorkspace: () =>
      run(SubagentService.use((service) => service.inspectWriterWorkspace)),
    setWriterWorkspaceMode: (mode) =>
      withCurrentActivation((activation) =>
        run(
          Effect.gen(function* () {
            const store = yield* SubagentConfigStore;
            const service = yield* SubagentService;
            const projectTrusted = activation.ctx.isProjectTrusted();
            const inspection = yield* store.inspect(
              activation.cwd,
              activation.agentDirectory,
              projectTrusted,
            );
            const scope = projectTrusted ? "project" : "global";
            const document =
              scope === "project" ? inspection.projectDocument : inspection.globalDocument;
            yield* service.setWriterWorkspaceMode(
              mode,
              store.patchWriterWorkspace(activation.cwd, activation.agentDirectory, {
                scope,
                expectedExists: document !== undefined,
                expectedDocument: document,
                projectTrusted,
                writerWorkspaceMode: mode,
              }),
            );
          }),
        ),
      ),
    patchProfile: withConfigStore((store) => store.patchProfile),
    restoreProfileDeclaration: withConfigStore((store) => store.restoreProfileDeclaration),
    patchDefaultProfileSet: withConfigStore((store) => store.patchDefaultProfileSet),
    createProfileSetFromSnapshot: (request) =>
      withCurrentActivation((activation) => {
        const { expectedRevision, ...patch } = request;
        return run(
          Effect.gen(function* () {
            const store = yield* SubagentConfigStore;
            const profiles = yield* SubagentProfileService;
            yield* profiles.withSnapshotAtRevision(expectedRevision, (snapshot) =>
              store.createProfileSetFromSnapshot(activation.cwd, activation.agentDirectory, {
                ...patch,
                profiles: snapshot.effectiveConfig.profiles,
              }),
            );
          }),
        );
      }),
    copyProfileSet: withConfigStore((store) => store.copyProfileSet),
    renameProfileSet: withConfigStore((store) => store.renameProfileSet),
    deleteProfileSet: withConfigStore((store) => store.deleteProfileSet),
    patchNesting: withConfigStore((store) => store.patchNesting),
    patchFeatureToggle: withConfigStore((store) => store.patchFeatureToggle),
    patchSessionFeatureToggle: (patch) => applySessionFeature(() => patch),
    patchSessionProfile: (patch) =>
      runCurrent(SubagentProfileService.use((profiles) => profiles.patchSessionProfile(patch))),
    replaceSessionProfiles: (patch) =>
      runCurrent(SubagentProfileService.use((profiles) => profiles.replaceSessionProfiles(patch))),
    patchSessionNesting: (patch) =>
      run(SubagentProfileService.use((profiles) => profiles.patchSessionNesting(patch))).then(
        () => undefined,
      ),
    listNativeModels: (runtime, signal) =>
      withCurrentActivation((activation) =>
        run(
          NativeModelCatalog.use((catalog) => catalog.list(runtime, activation.cwd)),
          signal,
        ),
      ),
  };
  registerSubagentManagerCommand(pi, bridge, managerActions);
  registerUltracodeCommand(pi, {
    isAvailable: () => current() !== undefined,
    status: () =>
      runCurrent(
        Effect.gen(function* () {
          const session = yield* SubagentProfileService.use((profiles) => profiles.capture);
          const saved = yield* WorkflowStore.use((store) => store.list);
          const window = ultracode.window();
          return {
            enabled: session.effectiveConfig.ultracode,
            source: session.effectiveConfig.featureSources.ultracode,
            window: { open: isUltracodeWindowOpen(window), runs: window.runs.length },
            saved,
          };
        }),
      ),
    setSession: (enabled) =>
      applySessionFeature((snapshot) => ({
        toggle: "ultracode",
        enabled,
        expectedRevision: snapshot.revision,
      })),
    send: ultracode.send,
  });
}
