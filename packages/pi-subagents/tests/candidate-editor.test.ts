// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { NativeRuntimeModel } from "../src/boundary/native-model-catalog.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  loadCandidateModelPicker,
  updateCandidateFromModelChoice,
} from "../src/settings/ui/candidate-editor.ts";

const candidate = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  host: "local",
  runtime: "claude",
  model: "claude-opus-5",
  effort: "xhigh",
  context: "fresh",
  writeIntent: "read-only",
  closeOnReport: true,
  ...overrides,
});

const claudeModels: ReadonlyArray<NativeRuntimeModel> = [
  {
    selector: "default",
    label: "Default",
    description: "Default Claude model",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    isDefault: true,
  },
  {
    selector: "sonnet",
    label: "Sonnet",
    description: "Efficient Claude model",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    isDefault: false,
  },
];

const context = () =>
  ({
    modelRegistry: { getAvailable: () => [], find: () => undefined },
  }) as unknown as ExtensionCommandContext;

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
      "claude-opus-5",
    ]);
    expect(
      updateCandidateFromModelChoice(current, picker, { kind: "model", selector: "sonnet" }),
    ).toEqual({ candidate: candidate({ model: "sonnet" }), notices: [] });
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

  it("reports an empty Pi catalog without opening an unusable page", async () => {
    const picker = await loadCandidateModelPicker(context(), {
      profile: "reviewer",
      candidateIndex: 0,
      candidate: candidate({ host: "herdr", runtime: "pi", model: "openai/missing" }),
      listNativeModels: vi.fn(),
    });

    expect(picker.choices).toEqual([]);
    expect(picker.warning).toContain("No authenticated canonical Pi models");
  });
});
