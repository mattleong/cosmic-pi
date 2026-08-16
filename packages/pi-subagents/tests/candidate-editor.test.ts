// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { describe, expect, it, vi } from "vitest";
import type { NativeRuntimeModel } from "../src/boundary/native-model-catalog.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  loadCandidateModelPicker,
  updateCandidateFromModelChoice,
} from "../src/settings/ui/candidate-editor.ts";
import { extensionContextFixture } from "./fixtures/pi-host.ts";

const candidate = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  host: "local",
  runtime: "claude",
  model: "claude-opus-5",
  effort: "xhigh",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  closeOnReport: true,
  ...overrides,
});

const claudeModels: ReadonlyArray<NativeRuntimeModel> = [
  {
    selector: "default",
    label: "Default",
    description: "Default Claude model",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedServiceTiers: [],
    isDefault: true,
  },
  {
    selector: "sonnet",
    label: "Sonnet",
    description: "Efficient Claude model",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    supportedServiceTiers: [],
    isDefault: false,
  },
  {
    selector: "opus[1m]",
    label: "Opus 1M",
    description: "Long-context Claude model",
    supportedEfforts: ["high", "xhigh"],
    supportedServiceTiers: [],
    isDefault: false,
  },
];

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const context = () =>
  extensionContextFixture({
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      getRegisteredProviderIds: () => [],
    },
  });

describe("inline candidate model editor", () => {
  it("loads Claude's advertised catalog for the workspace picker page", async () => {
    const listNativeModels = vi.fn().mockResolvedValue(claudeModels);
    const current = candidate();
    const picker = await loadCandidateModelPicker(context(), {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: current,
      listNativeModels,
    });

    expect(listNativeModels).toHaveBeenCalledWith("claude");
    expect(picker.context).toMatchObject({ profile: "reviewer", runtime: "claude" });
    expect(picker.choices.map((choice) => choice.item.value)).toEqual([
      "default",
      "sonnet",
      "opus[1m]",
      "claude-opus-5",
    ]);
    expect(
      updateCandidateFromModelChoice(current, picker, { kind: "model", selector: "sonnet" }),
    ).toEqual({ candidate: candidate({ model: "sonnet" }), notices: [] });
    expect(
      updateCandidateFromModelChoice(current, picker, { kind: "model", selector: "opus[1m]" }),
    ).toEqual({ candidate: candidate({ model: "opus[1m]" }), notices: [] });
  });

  it("uses Codex-advertised priority tiers to preserve or reset fast mode", async () => {
    const current = candidate({
      runtime: "codex",
      model: "gpt-priority",
      fastMode: true,
    });
    const picker = await loadCandidateModelPicker(context(), {
      profile: "worker",
      candidateIndex: 0,
      candidate: current,
      listNativeModels: vi.fn().mockResolvedValue([
        {
          selector: "gpt-priority",
          label: "GPT Priority",
          description: "Priority capable",
          supportedEfforts: ["high"],
          supportedServiceTiers: ["priority"],
          isDefault: true,
        },
        {
          selector: "gpt-standard",
          label: "GPT Standard",
          description: "Standard only",
          supportedEfforts: ["high"],
          supportedServiceTiers: [],
          isDefault: false,
        },
      ] satisfies ReadonlyArray<NativeRuntimeModel>),
    });

    expect(
      picker.choices
        .filter((choice) => ["gpt-priority", "gpt-standard"].includes(choice.item.value))
        .map((choice) => choice.fastModeAvailable),
    ).toEqual([true, false]);
    const updated = updateCandidateFromModelChoice(current, picker, {
      kind: "model",
      selector: "gpt-standard",
    });
    expect(updated.candidate).toMatchObject({ model: "gpt-standard", fastMode: false });
    expect(updated.notices.join(" ")).toContain("Fast mode is unavailable");
  });

  it("omits advertised models whose selectors cannot be safely persisted or launched", async () => {
    const picker = await loadCandidateModelPicker(context(), {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate(),
      listNativeModels: vi.fn().mockResolvedValue([
        ...claudeModels,
        {
          selector: "unsafe model",
          label: "Unsafe",
          description: "Cannot be passed as a native selector",
          supportedEfforts: ["low"],
          supportedServiceTiers: [],
          isDefault: false,
        },
      ] satisfies ReadonlyArray<NativeRuntimeModel>),
    });

    expect(picker.choices.map((choice) => choice.item.value)).not.toContain("unsafe model");
    expect(picker.warning).toContain("unsafe selectors");
  });

  it("falls back to searchable current/default choices when native discovery fails", async () => {
    const current = candidate();
    const picker = await loadCandidateModelPicker(context(), {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: current,
      listNativeModels: vi.fn().mockRejectedValue(new Error("Claude catalog unavailable.")),
    });

    expect(picker.warning).toContain("Showing current/default model choices");
    expect(picker.choices.map((choice) => choice.item.value)).toEqual(["claude-opus-5"]);
    expect(
      updateCandidateFromModelChoice(current, picker, {
        kind: "model",
        selector: "claude-opus-5",
      }).candidate,
    ).toEqual(current);
  });

  it("omits authenticated Pi models with unsafe canonical selectors", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unsafeContext = extensionContextFixture({
      modelRegistry: {
        getAvailable: () => [{ provider: "unsafe provider", id: "model" }],
        find: () => undefined,
        getRegisteredProviderIds: () => [],
      },
    });
    const picker = await loadCandidateModelPicker(unsafeContext, {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({ host: "herdr", runtime: "pi", model: "openai/current" }),
      listNativeModels: vi.fn(),
    });
    expect(picker.choices.map((choice) => choice.item.value)).not.toContain(
      "unsafe provider/model",
    );
    expect(picker.warning).toContain("canonical selector is unsafe");
  });

  it("keeps authenticated Cursor context variants with @ in Pi choices", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const cursorContext = extensionContextFixture({
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "cursor",
            id: "gpt-5.5@1m",
            name: "Cursor GPT 5.5 1M",
            reasoning: true,
          },
        ],
        find: () => undefined,
        getRegisteredProviderIds: () => ["cursor"],
      },
    });
    const picker = await loadCandidateModelPicker(cursorContext, {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({ runtime: "pi", model: "cursor/gpt-5.5@1m" }),
      listNativeModels: vi.fn(),
    });

    expect(picker.choices.map((choice) => choice.item.value)).toContain("cursor/gpt-5.5@1m");
    expect(picker.warning ?? "").not.toContain("canonical selector is unsafe");
  });

  it("omits extension providers for Herdr Pi but keeps them for local Pi", async () => {
    const registryModels = [
      { provider: "openai", id: "gpt-safe", name: "Safe", reasoning: true },
      {
        provider: "cursor",
        id: "gpt-5.5@1m",
        name: "Cursor GPT 5.5 1M",
        reasoning: true,
      },
    ];
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const providerContext = extensionContextFixture({
      modelRegistry: {
        getAvailable: () => registryModels,
        find: () => undefined,
        getRegisteredProviderIds: () => ["cursor"],
      },
    });
    const base = {
      profile: "reviewer" as const,
      candidateIndex: 0,
      listNativeModels: vi.fn(),
    };
    const herdr = await loadCandidateModelPicker(providerContext, {
      ...base,
      candidate: candidate({ host: "herdr", runtime: "pi", model: "openai/gpt-safe" }),
    });
    const local = await loadCandidateModelPicker(providerContext, {
      ...base,
      candidate: candidate({ host: "local", runtime: "pi", model: "openai/gpt-safe" }),
    });

    expect(herdr.choices.map((choice) => choice.item.value)).toEqual(["openai/gpt-safe"]);
    expect(herdr.warning).toContain("Herdr Pi disables extension discovery");
    expect(local.choices.map((choice) => choice.item.value)).toContain("cursor/gpt-5.5@1m");
  });

  it("does not offer fast mode for a current Herdr model from an extension override", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const overrideContext = extensionContextFixture({
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "openai-codex",
            id: "gpt-5.6-sol",
            name: "GPT 5.6 Sol Override",
            reasoning: true,
          },
        ],
        find: () => undefined,
        getRegisteredProviderIds: () => ["openai-codex"],
      },
    });
    const picker = await loadCandidateModelPicker(overrideContext, {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({
        host: "herdr",
        runtime: "pi",
        model: "openai-codex/gpt-5.6-sol",
        fastMode: true,
      }),
      listNativeModels: vi.fn(),
    });

    expect(picker.choices).toHaveLength(1);
    expect(picker.choices[0]?.fastModeAvailable).toBe(false);
    expect(picker.warning).toContain("sterile Herdr Pi cannot load");
  });

  it("fails Herdr Pi choices closed when provider provenance is unavailable", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unavailableContext = extensionContextFixture({
      modelRegistry: {
        getAvailable: () => [{ provider: "openai", id: "gpt-safe", name: "Safe", reasoning: true }],
        find: () => undefined,
        getRegisteredProviderIds: () => {
          throw new Error("secret registry failure");
        },
      },
    });
    const picker = await loadCandidateModelPicker(unavailableContext, {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({ host: "herdr", runtime: "pi", model: "openai/gpt-safe" }),
      listNativeModels: vi.fn(),
    });

    expect(picker.warning).toContain("hidden fail-closed");
    expect(picker.warning).not.toContain("secret registry failure");
    expect(picker.choices).toHaveLength(1);
    expect(picker.choices[0]?.item.label).toContain("current · unavailable");
  });

  it("preserves an unavailable configured Pi model instead of selecting a replacement", async () => {
    const picker = await loadCandidateModelPicker(context(), {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({ host: "herdr", runtime: "pi", model: "openai/missing" }),
      listNativeModels: vi.fn(),
    });

    expect(picker.choices).toHaveLength(1);
    expect(picker.choices[0]?.item.label).toContain("current · unavailable");
    expect(picker.current).toBe("openai/missing");
    expect(picker.warning).toContain("not currently authenticated");
  });
});
