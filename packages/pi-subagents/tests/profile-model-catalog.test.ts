import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Api, Model } from "@earendil-works/pi-ai";
import { deferredPromise } from "pi-cosmic-core/testing";
import { createModelPickerChoices } from "pi-cosmic-ui/manager/model-picker";
import type { NativeRuntimeModel } from "../src/boundary/native-model-catalog.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  loadCandidateModelPicker,
  type CandidateModelPickerData,
  type CandidateModelPickerInput,
  ProfileModelCatalog,
  type ProfileModelRegistry,
  type ProfileModelRegistryRefreshResult,
} from "../src/settings/profile-model-catalog.ts";
import type { ProfileModelOption } from "../src/settings/ui/model-picker.ts";
import { modelFixture } from "./fixtures/pi-host.ts";
import { profileCandidate } from "./fixtures/profiles.ts";

const piModel = (provider: string, id: string, name = id) =>
  modelFixture({
    provider,
    id,
    name,
    reasoning: true,
    thinkingLevelMap: { low: "low", high: "high" },
  });

const staticCatalog = (
  models: ReadonlyArray<Model<Api>>,
  scoped?: ReadonlyArray<Model<Api>>,
): ProfileModelCatalog =>
  new ProfileModelCatalog(
    {
      getAvailable: () => models,
      getError: () => undefined,
      refresh: () => Promise.resolve({ aborted: false }),
    },
    scoped,
  );

const loadPicker = (
  catalog: ProfileModelCatalog,
  candidate: ProfileCandidate,
  overrides: Partial<CandidateModelPickerInput> = {},
) =>
  Effect.promise(() =>
    loadCandidateModelPicker({
      profile: "reviewer",
      candidateIndex: 0,
      candidate,
      listNativeModels: () => Promise.resolve([]),
      piCatalog: catalog.capture(),
      ...overrides,
    }),
  );

const hasTerminalControls = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
};

describe("profile model catalog", () => {
  for (const lateFailure of [false, true]) {
    it.effect(
      `releases noncooperative refresh on interruption and ignores late ${lateFailure ? "rejection" : "publication"}`,
      () =>
        Effect.gen(function* () {
          const pending = yield* Deferred.make<ProfileModelRegistryRefreshResult, string>();
          let registrySignal: AbortSignal | undefined;
          let models = [piModel("openai", "old")];
          const entered = yield* Deferred.make<void>();
          const catalog = new ProfileModelCatalog({
            getAvailable: () => models,
            getError: () => undefined,
            refresh: (options) => {
              registrySignal = options?.signal;
              Deferred.doneUnsafe(entered, Effect.void);
              return Effect.runPromise(Deferred.await(pending));
            },
          });
          const initial = catalog.capture();
          const refreshing = yield* catalog.refresh().pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(refreshing);
          expect(registrySignal?.aborted).toBe(true);
          models = [piModel("openai", "late")];
          if (lateFailure) yield* Deferred.fail(pending, "late failure");
          else yield* Deferred.succeed(pending, { aborted: false });
          yield* Effect.promise(() => Promise.resolve());
          expect(catalog.capture()).toBe(initial);
        }),
    );
  }
  it.effect("atomically replaces one immutable snapshot and retains it on failure or abort", () =>
    Effect.gen(function* () {
      let models = [piModel("openai", "gpt-old")];
      let registryError: string | undefined;
      let refresh = deferredPromise<ProfileModelRegistryRefreshResult>();
      const registry: ProfileModelRegistry = {
        getAvailable: () => models,
        getError: () => registryError,
        refresh: () => refresh.promise,
      };
      const catalog = new ProfileModelCatalog(registry);
      const initial = catalog.capture();
      expect(initial).toMatchObject({
        revision: 0,
        piModels: [{ provider: "openai", id: "gpt-old" }],
      });
      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial.piModels)).toBe(true);

      const updating = Effect.runPromise(catalog.refresh());
      models = [piModel("openai", "gpt-new")];
      expect(catalog.capture()).toBe(initial);
      refresh.resolve({ aborted: false });
      expect(yield* Effect.promise(() => updating)).toBe("updated");
      const updated = catalog.capture();
      expect(updated).toMatchObject({
        revision: 1,
        piModels: [{ provider: "openai", id: "gpt-new" }],
      });
      expect(updated.piModels.some((model) => model.id === "gpt-old")).toBe(false);

      registryError = "registry refresh failed";
      refresh = deferredPromise<ProfileModelRegistryRefreshResult>();
      const failing = Effect.runPromise(catalog.refresh());
      models = [piModel("openai", "gpt-failed")];
      refresh.resolve({ aborted: false });
      expect(yield* Effect.promise(() => failing)).toBe("failed");
      expect(catalog.capture()).toBe(updated);

      registryError = undefined;
      refresh = deferredPromise<ProfileModelRegistryRefreshResult>();
      const aborting = Effect.runPromise(catalog.refresh());
      models = [piModel("openai", "gpt-aborted")];
      refresh.resolve({ aborted: true });
      expect(yield* Effect.promise(() => aborting)).toBe("aborted");
      expect(catalog.capture()).toBe(updated);
    }),
  );

  it.effect("projects scoped Pi models separately from all authenticated models", () =>
    Effect.gen(function* () {
      const scoped = piModel("openai", "scoped");
      const catalog = staticCatalog([scoped, piModel("anthropic", "all-only")], [scoped]);
      const picker = yield* loadPicker(catalog, profileCandidate("openai/scoped"));
      const selectors = (options: ReadonlyArray<ProfileModelOption> = []) =>
        options.map((option) => option.selector);
      expect(selectors(picker.scopedChoices)).toContain("openai/scoped");
      expect(selectors(picker.scopedChoices)).not.toContain("anthropic/all-only");
      expect(selectors(picker.choices)).toContain("anthropic/all-only");
    }),
  );

  it.effect("marks a retained unavailable current model as non-selectable", () =>
    Effect.gen(function* () {
      const catalog = staticCatalog([piModel("openai", "available")]);
      const picker = yield* loadPicker(catalog, profileCandidate("openai/missing"));
      const retained = picker.choices.find((option) => option.selector === "openai/missing");

      expect(retained).toMatchObject({ available: false, fastModeAvailable: false });
      expect(retained?.unavailableReason).toBeTruthy();
    }),
  );

  it.effect("sanitizes Pi and native display text without changing selector identity", () =>
    Effect.gen(function* () {
      const catalog = staticCatalog([
        piModel("openai", "gpt-old", "Parent\u001b[2J\nrenamed"),
        piModel("openai", "gpt-next", "Next\u0007\tmodel"),
      ]);
      // Pi rows use the shared picker's default text, so check what the picker displays.
      const displayed = (picker: CandidateModelPickerData) => {
        const choices = createModelPickerChoices(picker.choices, picker.current);
        for (const choice of choices) {
          expect(hasTerminalControls(choice.item.label)).toBe(false);
          expect(hasTerminalControls(choice.item.description ?? "")).toBe(false);
          expect(hasTerminalControls(choice.searchText)).toBe(false);
        }
        return choices;
      };
      const pi = displayed(
        yield* loadPicker(catalog, profileCandidate("openai/gpt-old"), {
          parentSelector: "openai/gpt-old",
        }),
      );
      const renamed = pi.find((choice) => choice.value === "openai/gpt-old");
      expect(renamed?.payload.selector).toBe("openai/gpt-old");
      expect(renamed?.item.description).toContain("renamed");
      expect(pi.some((choice) => choice.payload.selector === "parent")).toBe(true);

      const native = displayed(
        yield* loadPicker(catalog, profileCandidate("claude-safe", { runtime: "claude" }), {
          listNativeModels: () =>
            Promise.resolve([
              {
                selector: "claude-safe",
                label: "Claude\u001b[2J\nSafe",
                description: "Native\u0007 description",
                supportedEfforts: ["high"],
                supportedServiceTiers: [],
                isDefault: true,
              },
            ]),
        }),
      ).find((choice) => choice.value === "claude-safe");
      expect(native?.payload.selector).toBe("claude-safe");
      expect(native?.item.description).toContain("Safe");
    }),
  );

  it.effect("keeps trusted extension-provider models eligible and uses live Codex tiers", () =>
    Effect.gen(function* () {
      const catalog = staticCatalog([piModel("openai-codex", "gpt-5.6-sol")]);
      const pi = yield* loadPicker(catalog, profileCandidate("openai-codex/gpt-5.6-sol"));
      expect(pi.warning).toBeUndefined();
      expect(
        pi.choices.find((choice) => choice.selector === "openai-codex/gpt-5.6-sol"),
      ).toMatchObject({ fastModeAvailable: true });

      const advertised: NativeRuntimeModel = {
        selector: "future-codex",
        label: "Future Codex",
        description: "Advertised live catalog model",
        supportedEfforts: ["high"],
        supportedServiceTiers: ["priority"],
        isDefault: true,
      };
      const codexCandidate = profileCandidate(advertised.selector, { runtime: "codex" });
      const fastModeFor = (picker: CandidateModelPickerData) =>
        picker.choices.find((option) => option.selector === advertised.selector)?.fastModeAvailable;
      const live = yield* loadPicker(catalog, codexCandidate, {
        profile: "worker",
        listNativeModels: () => Promise.resolve([advertised]),
      });
      expect(fastModeFor(live)).toBe(true);

      const fallback = yield* loadPicker(catalog, codexCandidate, {
        profile: "worker",
        listNativeModels: () => Promise.reject(new Error("catalog\u001b[2J failed")),
      });
      expect(fastModeFor(fallback)).toBe(false);
      expect(hasTerminalControls(fallback.warning ?? "")).toBe(false);

      // A runtime switch offers only live models, never the previous runtime's model.
      const switching = profileCandidate("openai-codex/gpt-5.6-sol", { runtime: "codex" });
      const pending = yield* loadPicker(catalog, switching, {
        listNativeModels: () => Promise.resolve([advertised]),
        modelPending: true,
      });
      expect(pending.choices.map((option) => option.selector)).toEqual([advertised.selector]);
      expect(pending.defaultSelector).toBe(advertised.selector);
      const offline = yield* loadPicker(catalog, switching, {
        listNativeModels: () => Promise.reject(new Error("catalog failed")),
        modelPending: true,
      });
      expect(offline.choices).toEqual([]);
    }),
  );
});
