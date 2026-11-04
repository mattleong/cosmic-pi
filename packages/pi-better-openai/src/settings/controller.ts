import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import type { ExtensionCommand } from "pi-cosmic-core";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { OwnedSurfaceOutcome } from "pi-cosmic-ui/boundary/host-surface";
import * as Schema from "effect/Schema";
import { InvalidSettingError } from "pi-cosmic-core/settings-completion";
import {
  formatOnOff,
  ON_OFF_VALUES,
  OnOffSchema,
  SETTINGS_OPTION_DESCRIPTORS,
} from "../config/options.ts";
import { safeHostSignal } from "../boundary/host-ui.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { FastSnapshot } from "../fast/controller.ts";
import { FastModeService } from "../fast/service.ts";
import { OpenAIConfigService } from "../config/store.ts";

export interface SettingsControllerOptions {
  readonly config: () => ResolvedConfig | undefined;
  readonly updateContext: (ctx: ExtensionContext) => void;
  readonly updateFooter: (ctx: ExtensionContext) => void;
  readonly formatDebugStatus: (ctx: ExtensionContext) => string;
  readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
  readonly resetFastRoutingTransport: (ctx: ExtensionContext) => void;
  readonly captureAuthority: () => () => boolean;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, OpenAIConfigService | FastModeService>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly loadMenu?: () => PromiseLike<typeof import("./menu.ts")>;
}

export function registerSettingsController(
  command: ExtensionCommand,
  options: SettingsControllerOptions,
): void {
  const {
    config,
    updateContext,
    updateFooter,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport,
    run,
  } = options;
  const fastEnabledDescriptor = {
    id: "fast.enabled",
    label: "Fast mode",
    values: ON_OFF_VALUES,
    description: "Request OpenAI fast mode for any openai or openai-codex model.",
    currentValue: (_cfg: ResolvedConfig) =>
      formatOnOff(MutableRef.get(fastProjection).desiredActive),
  };
  // Each decoder judges typed values, so `true`, `1m 30s`, or `45000` work beside the listed ones.
  const descriptors = Arr.map([fastEnabledDescriptor, ...SETTINGS_OPTION_DESCRIPTORS], (entry) => ({
    ...entry,
    openValues: true,
  }));

  const createCommand = (
    isCurrent: () => boolean,
    owner: SettingsCommandOwner,
    invocationSignal?: AbortSignal,
  ) =>
    settingsSubcommand({
      owner,
      root: "openai",
      description: "Configure Better OpenAI",
      title: "Better OpenAI",
      isCurrent,
      descriptors,
      examples: ["fast.enabled on", "usage.refreshIntervalMs 30s"],
      config,
      status: formatDebugStatus,
      onInvoke: updateContext,
      signal: "optional",
      apply: (ctx, id, value, signal) =>
        run(
          Effect.gen(function* () {
            if (id !== "fast.enabled")
              return yield* OpenAIConfigService.use((service) => service.updateSetting(id, value));
            const desired = yield* Schema.decodeEffect(OnOffSchema)(value).pipe(
              Effect.mapError(() =>
                InvalidSettingError.make({ id, message: `${id} must be on or off` }),
              ),
            );
            yield* FastModeService.use((service) => service.setDesired(ctx, desired));
            yield* Effect.sync(() => {
              if (isCurrent()) resetFastRoutingTransport(ctx);
            });
            return undefined;
          }).pipe(Effect.result),
          signal,
        ),
      afterApply: updateFooter,
      open: (ctx, session) =>
        Promise.resolve()
          .then(() => {
            if (!isCurrent()) return undefined;
            return options.loadMenu?.() ?? import("./menu.ts");
          })
          .then((menu) =>
            menu && isCurrent()
              ? menu.openOpenAISettingsMenu(
                  ctx,
                  session,
                  options,
                  isCurrent,
                  fastEnabledDescriptor,
                  invocationSignal,
                )
              : OwnedSurfaceOutcome.Settled({ value: undefined }),
          )
          .catch((cause: unknown) => OwnedSurfaceOutcome.Failed({ cause })),
    });
  command.add(
    withInvocationAuthority(options.captureAuthority, (isCurrent, owner) => ({
      ...createCommand(isCurrent, owner),
      handler: (args, ctx) => {
        const signal = safeHostSignal(ctx);
        return createCommand(() => isCurrent() && !signal?.aborted, owner, signal).handler(
          args,
          ctx,
        );
      },
    })),
  );
}
