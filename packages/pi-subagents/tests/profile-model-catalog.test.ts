import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { NativeRuntimeModel } from "../src/boundary/native-model-catalog.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  loadCandidateModelPicker,
  preferredHerdrPiSelector,
  ProfileModelCatalog,
  type ProfileModelRegistry,
  type ProfileModelRegistryRefreshResult,
} from "../src/settings/profile-model-catalog.ts";
import { modelFixture } from "./fixtures/pi-host.ts";

const piModel = (provider: string, id: string, name = id) =>
  modelFixture({
    provider,
    id,
    name,
    reasoning: true,
    thinkingLevelMap: { low: "low", high: "high" },
  });

const candidate = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "openai/gpt-old",
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  closeOnReport: true,
  ...overrides,
});

const deferred = () => {
  const cell = Deferred.makeUnsafe<ProfileModelRegistryRefreshResult>();
  return {
    promise: Effect.runPromise(Deferred.await(cell)),
    resolve: () => Deferred.doneUnsafe(cell, Effect.succeed({ aborted: false })),
  };
};

const hasTerminalControls = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
};

describe("profile model catalog", () => {
  it.effect("atomically replaces one immutable snapshot and retains it on failure or abort", () =>
    Effect.gen(function* () {
      let models = [piModel("openai", "gpt-old")];
      let registryError: string | undefined;
      let refresh = deferred();
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

      const updating = catalog.refresh();
      models = [piModel("openai", "gpt-new")];
      expect(catalog.capture()).toBe(initial);
      refresh.resolve();
      expect(yield* Effect.promise(() => updating)).toBe("updated");
      const updated = catalog.capture();
      expect(updated).toMatchObject({
        revision: 1,
        piModels: [{ provider: "openai", id: "gpt-new" }],
      });
      expect(updated.piModels.some((model) => model.id === "gpt-old")).toBe(false);

      registryError = "registry refresh failed";
      refresh = deferred();
      const failing = catalog.refresh();
      models = [piModel("openai", "gpt-failed")];
      refresh.resolve();
      expect(yield* Effect.promise(() => failing)).toBe("failed");
      expect(catalog.capture()).toBe(updated);

      registryError = undefined;
      refresh = deferred();
      const controller = new AbortController();
      const aborting = catalog.refresh(controller.signal);
      models = [piModel("openai", "gpt-aborted")];
      controller.abort();
      refresh.resolve();
      expect(yield* Effect.promise(() => aborting)).toBe("aborted");
      expect(catalog.capture()).toBe(updated);
    }),
  );

  it.effect("derives the preferred Herdr Pi selector from the current snapshot", () =>
    Effect.gen(function* () {
      let models = [piModel("native", "first"), piModel("extension", "eligible")];
      const registry: ProfileModelRegistry = {
        getAvailable: () => models,
        getError: () => undefined,
        refresh: () => Promise.resolve({ aborted: false }),
      };
      const catalog = new ProfileModelCatalog(registry);
      expect(preferredHerdrPiSelector(catalog.capture(), "native/first")).toBe("native/first");

      models = [piModel("native", "second"), piModel("extension2", "eligible")];
      expect(yield* Effect.promise(() => catalog.refresh())).toBe("updated");
      expect(preferredHerdrPiSelector(catalog.capture(), "native/first")).toBe("native/second");
    }),
  );

  it.effect("sanitizes Pi and native display text without changing selector identity", () =>
    Effect.gen(function* () {
      const registry: ProfileModelRegistry = {
        getAvailable: () => [
          piModel("openai", "gpt-old", "Parent\u001b[2J\nrenamed"),
          piModel("openai", "gpt-next", "Next\u0007\tmodel"),
        ],
        getError: () => undefined,
        refresh: () => Promise.resolve({ aborted: false }),
      };
      const catalog = new ProfileModelCatalog(registry);
      const piPicker = yield* Effect.promise(() =>
        loadCandidateModelPicker({
          profile: "reviewer",
          candidateIndex: 0,
          candidate: candidate(),
          listNativeModels: () => Promise.resolve([]),
          piCatalog: catalog.capture(),
          parentSelector: "openai/gpt-old",
        }),
      );
      const selected = piPicker.choices.find(
        (choice) => choice.choice.kind === "model" && choice.choice.selector === "openai/gpt-old",
      );
      expect(selected?.item.value).toBe("openai/gpt-old");
      expect(selected?.choice).toEqual({ kind: "model", selector: "openai/gpt-old" });
      for (const choice of piPicker.choices) {
        expect(hasTerminalControls(choice.item.label)).toBe(false);
        expect(hasTerminalControls(choice.item.description ?? "")).toBe(false);
        expect(hasTerminalControls(choice.searchText)).toBe(false);
      }

      const nativePicker = yield* Effect.promise(() =>
        loadCandidateModelPicker({
          profile: "reviewer",
          candidateIndex: 0,
          candidate: candidate({ runtime: "claude", model: "claude-safe" }),
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
          piCatalog: catalog.capture(),
        }),
      );
      expect(nativePicker.choices[0]?.item.value).toBe("claude-safe");
      expect(nativePicker.choices[0]?.choice).toEqual({ kind: "model", selector: "claude-safe" });
      expect(hasTerminalControls(nativePicker.choices[0]?.item.label ?? "")).toBe(false);
      expect(hasTerminalControls(nativePicker.choices[0]?.item.description ?? "")).toBe(false);
      expect(hasTerminalControls(nativePicker.choices[0]?.searchText ?? "")).toBe(false);
    }),
  );

  it.effect(
    "keeps trusted extension-provider models eligible for Herdr and uses live Codex tiers",
    () =>
      Effect.gen(function* () {
        const registry: ProfileModelRegistry = {
          getAvailable: () => [piModel("openai-codex", "gpt-5.6-sol")],
          getError: () => undefined,
          refresh: () => Promise.resolve({ aborted: false }),
        };
        const catalog = new ProfileModelCatalog(registry);
        const herdr = yield* Effect.promise(() =>
          loadCandidateModelPicker({
            profile: "reviewer",
            candidateIndex: 0,
            candidate: candidate({ host: "herdr", model: "openai-codex/gpt-5.6-sol" }),
            listNativeModels: () => Promise.resolve([]),
            piCatalog: catalog.capture(),
          }),
        );
        expect(herdr.warning).toBeUndefined();
        expect(herdr.choices).toHaveLength(1);
        expect(herdr.choices[0]?.item.value).toBe("openai-codex/gpt-5.6-sol");
        expect(herdr.choices[0]?.fastModeAvailable).toBe(true);

        const advertised: NativeRuntimeModel = {
          selector: "future-codex",
          label: "Future Codex",
          description: "Advertised live catalog model",
          supportedEfforts: ["high"],
          supportedServiceTiers: ["priority"],
          isDefault: true,
        };
        const codexCandidate = candidate({ runtime: "codex", model: advertised.selector });
        const live = yield* Effect.promise(() =>
          loadCandidateModelPicker({
            profile: "worker",
            candidateIndex: 0,
            candidate: codexCandidate,
            listNativeModels: () => Promise.resolve([advertised]),
            piCatalog: catalog.capture(),
          }),
        );
        expect(live.choices[0]?.fastModeAvailable).toBe(true);

        const fallback = yield* Effect.promise(() =>
          loadCandidateModelPicker({
            profile: "worker",
            candidateIndex: 0,
            candidate: codexCandidate,
            listNativeModels: () => Promise.reject(new Error("catalog\u001b[2J failed")),
            piCatalog: catalog.capture(),
          }),
        );
        expect(
          fallback.choices.find((choice) => choice.item.value === advertised.selector)
            ?.fastModeAvailable,
        ).toBe(false);
        expect(hasTerminalControls(fallback.warning ?? "")).toBe(false);
      }),
  );
});
