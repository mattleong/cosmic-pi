import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import {
  makeModelPickerPage,
  modelSelector,
  type ModelPickerModel,
} from "pi-cosmic-ui/manager/model-picker";
import { PiCommandError, selectAtHostCommandBoundary } from "./host-commands.ts";

export type AdvisorOnboardingChoice =
  | { readonly type: "model"; readonly provider: string; readonly model: string }
  | { readonly type: "not-now" };

type AdvisorOnboardingContext = Pick<
  ExtensionContext,
  "hasUI" | "mode" | "model" | "modelRegistry" | "scopedModels" | "ui"
>;

type AdvisorPickerModel = ModelPickerModel;
type AdvisorPickerResult = AdvisorOnboardingChoice | undefined;

type AdvisorPickerFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: AdvisorPickerResult) => void,
) => Component;

const neutralComponent = (): Component => ({
  render: () => [],
  invalidate: () => undefined,
  handleInput: () => undefined,
});

const projectModel = (model: {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoning?: boolean | undefined;
}): AdvisorPickerModel => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
  reasoning: model.reasoning,
});

const sortModels = (models: ReadonlyArray<AdvisorPickerModel>): AdvisorPickerModel[] =>
  [...models].sort((left, right) => modelSelector(left).localeCompare(modelSelector(right)));

/** Owns the signal-less Pi custom surface so interruption cannot leave a focused picker behind. */
const openAdvisorModelPickerAtHostBoundary = (
  ctx: AdvisorOnboardingContext,
  models: ReadonlyArray<AdvisorPickerModel>,
  scopedModels: ReadonlyArray<AdvisorPickerModel>,
): Effect.Effect<AdvisorPickerResult, PiCommandError> =>
  Effect.suspend(() => {
    let closing = false;
    let factoryInvoked = false;
    let doneInvoked = false;
    let requested: { readonly result: AdvisorPickerResult } | undefined;
    let hostDone: ((result: AdvisorPickerResult) => void) | undefined;
    let hostTui: TUI | undefined;
    let overlay: OverlayHandle | undefined;
    let rejectCompletion: (() => void) | undefined;
    const finish = (result: AdvisorPickerResult): void => {
      requested ??= { result };
      if (doneInvoked || !hostDone || !hostTui || !overlay) return;
      doneInvoked = true;
      try {
        // Pi 0.85 done pops the global stack. Use Ask User's owned-overlay guard
        // so a foreign overlay survives both selection and cancellation.
        overlay.hide();
        const guard = hostTui.showOverlay(neutralComponent(), { nonCapturing: true });
        try {
          hostDone(requested.result);
        } finally {
          guard.hide();
        }
      } catch {
        // Pi's Promise may never settle if cleanup throws before done resolves it.
        // Settle the Effect independently; never retry an unguarded global pop.
        rejectCompletion?.();
      }
    };
    const close = (): void => {
      closing = true;
      finish(undefined);
    };
    const factory: AdvisorPickerFactory = (tui, theme, keybindings, done) => {
      if (factoryInvoked) {
        close();
        return neutralComponent();
      }
      factoryInvoked = true;
      hostDone = done;
      hostTui = tui;
      if (closing) {
        close();
        return neutralComponent();
      }
      return makeModelPickerPage({
        theme,
        breadcrumb: "/advisor › setup › model",
        title: "Set up Advisor",
        subtitle: "Choose the model used for independent review",
        scopedModels,
        allModels: models,
        current: ctx.model ? modelSelector(ctx.model) : undefined,
        actions: [
          {
            id: "not-now",
            label: "Not now",
            description: "Dismiss automatic setup for this configuration",
            select: () => finish({ type: "not-now" }),
          },
        ],
        getHeight: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        keybindingLabel: (id, fallback) =>
          fullScreenKeybindingLabel(
            id,
            fallback,
            Predicate.isFunction(keybindings.getKeys)
              ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
              : undefined,
          ),
        select: (model) => finish({ type: "model", provider: model.provider, model: model.id }),
        cancel: () => finish(undefined),
      });
    };
    return Effect.callback<AdvisorPickerResult, PiCommandError>((resume) => {
      const fail = () =>
        resume(
          Effect.fail(
            new PiCommandError({
              operation: "model selection",
              message: "Advisor command failed.",
            }),
          ),
        );
      rejectCompletion = fail;
      try {
        ctx.ui
          .custom<AdvisorPickerResult>(factory, {
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
            onHandle: (handle) => {
              overlay = handle;
              if (closing || requested) finish(requested?.result);
            },
          })
          .then((result) => resume(Effect.succeed(result)), fail);
      } catch {
        fail();
      }
    }).pipe(Effect.ensuring(Effect.sync(close)));
  });

/** Pi-owned model discovery and setup UI stay behind one host boundary. */
export function selectAdvisorOnboardingAtHostBoundary(
  ctx: AdvisorOnboardingContext,
): Effect.Effect<AdvisorOnboardingChoice | void, PiCommandError> {
  if (ctx.mode !== "tui") return Effect.void;
  return Effect.try({
    try: () => {
      const models = sortModels(ctx.modelRegistry.getAvailable().map(projectModel));
      const available = new Map(models.map((model) => [modelSelector(model), model]));
      const scopedModels = sortModels(
        (ctx.scopedModels ?? [])
          .map(({ model }) => available.get(modelSelector(model)))
          .filter((model): model is AdvisorPickerModel => model !== undefined),
      );
      if (models.length === 0)
        ctx.ui.notify(
          "No authenticated models are available. Configure a provider in pi, then run /advisor setup.",
          "warning",
        );
      return { models, scopedModels };
    },
    catch: () =>
      new PiCommandError({
        operation: "model discovery",
        message: "Advisor command failed.",
      }),
  }).pipe(
    Effect.flatMap(({ models, scopedModels }) => {
      if (ctx.hasUI && Predicate.isFunction(ctx.ui.custom))
        return openAdvisorModelPickerAtHostBoundary(ctx, models, scopedModels);
      const labels = models.map(modelSelector);
      return selectAtHostCommandBoundary(ctx, "Set up Advisor", [...labels, "Not now"]).pipe(
        Effect.map((selected) => {
          if (!selected) return undefined;
          if (selected === "Not now") return { type: "not-now" } as const;
          const model = models.find((entry) => modelSelector(entry) === selected);
          return model
            ? ({ type: "model", provider: model.provider, model: model.id } as const)
            : undefined;
        }),
      );
    }),
  );
}
