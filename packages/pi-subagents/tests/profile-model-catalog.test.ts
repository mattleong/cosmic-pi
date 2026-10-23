import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Api, Model } from "@earendil-works/pi-ai";
import { codeUnitAt } from "pi-cosmic-core";
import { deferredPromise, modelFixture } from "pi-cosmic-core/testing";
import { createModelPickerChoices } from "pi-cosmic-ui/manager/model-picker";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  loadCandidateModelPicker,
  type CandidateModelPickerData,
  type CandidateModelPickerInput,
  ProfileModelCatalog,
  type ProfileModelRegistry,
  type ProfileModelRegistryRefreshResult,
} from "../src/settings/profile-model-catalog.ts";
import { profileCandidate } from "./fixtures/profiles.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const piModel = (provider: string, id: string, name = id) =>
  modelFixture({
    provider,
    id,
    name,
    reasoning: true,
    thinkingLevelMap: { low: "low", high: "high" },
  });

const staticCatalog = (models: ReadonlyArray<Model<Api>>): ProfileModelCatalog =>
  new ProfileModelCatalog({
    getAvailable: () => models,
    getError: () => undefined,
    refresh: () => Promise.resolve({ aborted: false }),
  });

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
    const code = codeUnitAt(value, index);
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
          const pending = deferredPromise<ProfileModelRegistryRefreshResult>();
          let registrySignal: AbortSignal | undefined;
          let models = [piModel("openai", "old")];
          const entered = yield* Deferred.make<void>();
          const catalog = new ProfileModelCatalog({
            getAvailable: () => models,
            getError: () => undefined,
            refresh: (options) => {
              registrySignal = options?.signal;
              Deferred.doneUnsafe(entered, Effect.void);
              return pending.promise;
            },
          });
          const initial = catalog.capture();
          const refreshing = yield* catalog.refresh().pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(refreshing);
          expect(registrySignal?.aborted).toBe(true);
          models = [piModel("openai", "late")];
          if (lateFailure) pending.reject(new Error("late failure"));
          else pending.resolve({ aborted: false });
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
        piModels: [{ provider: "openai", id: "gpt-old" }],
      });
      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial.piModels)).toBe(true);

      const updating = yield* Effect.forkScoped(catalog.refresh());
      models = [piModel("openai", "gpt-new")];
      expect(catalog.capture()).toBe(initial);
      refresh.resolve({ aborted: false });
      expect(yield* Fiber.join(updating)).toBe("updated");
      const updated = catalog.capture();
      expect(updated).toMatchObject({
        piModels: [{ provider: "openai", id: "gpt-new" }],
      });
      expect(Arr.some(updated.piModels, (model) => model.id === "gpt-old")).toBe(false);

      registryError = "registry refresh failed";
      refresh = deferredPromise<ProfileModelRegistryRefreshResult>();
      const failing = yield* Effect.forkScoped(catalog.refresh());
      models = [piModel("openai", "gpt-failed")];
      refresh.resolve({ aborted: false });
      expect(yield* Fiber.join(failing)).toBe("failed");
      expect(catalog.capture()).toBe(updated);

      registryError = undefined;
      refresh = deferredPromise<ProfileModelRegistryRefreshResult>();
      const aborting = yield* Effect.forkScoped(catalog.refresh());
      models = [piModel("openai", "gpt-aborted")];
      refresh.resolve({ aborted: true });
      expect(yield* Fiber.join(aborting)).toBe("aborted");
      expect(catalog.capture()).toBe(updated);
    }),
  );

  it.effect("sanitizes Pi and native display text without changing selector identity", () =>
    Effect.gen(function* () {
      const catalog = staticCatalog([
        piModel("openai", "gpt-old", "Parent\u001b[2J\nrenamed"),
        piModel("openai", "gpt-next", "Next\u0007\tmodel"),
      ]);
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
      const renamed = Option.getOrUndefined(
        Arr.findFirst(pi, (choice) => choice.value === "openai/gpt-old"),
      );
      expect(renamed?.payload.selector).toBe("openai/gpt-old");
      expect(renamed?.item.description).toContain("renamed");
      expect(Arr.some(pi, (choice) => choice.payload.selector === "parent")).toBe(true);

      const native = Option.getOrUndefined(
        Arr.findFirst(
          displayed(
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
          ),
          (choice) => choice.value === "claude-safe",
        ),
      );
      expect(native?.payload.selector).toBe("claude-safe");
      expect(native?.item.description).toContain("Safe");
    }),
  );
});
