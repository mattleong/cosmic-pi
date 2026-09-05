import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { effectTest, step } from "./support/effect-test.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
  type ProfileWorkspaceSaveResult,
} from "../src/settings/profile-workspace.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import type { ProfileRouteDraft } from "../src/settings/profile-route-editor.ts";

// SAFETY: Renderer fixture implements the Theme methods used by these components.
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const first: ProfileCandidate = {
  host: "local",
  runtime: "pi",
  model: "test/first",
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  closeOnReport: true,
};
const second: ProfileCandidate = { ...first, model: "test/second" };
const tick = (): Promise<void> =>
  Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow)));
const harness = (overrides: Partial<ProfileWorkspaceOptions> = {}, initial = [first, second]) => {
  let candidates: ReadonlyArray<ProfileCandidate> = initial;
  const inspection = () =>
    makeProfileSettingsInspection(
      {
        globalDocument: {
          version: 6,
          defaultProfileSet: "default",
          profileSets: { default: { profiles: {} } },
        },
        projectTrusted: true,
      },
      { revision: 1, overrides: { generalist: { candidates } } },
    );
  const close = vi.fn();
  const saveDraft = vi.fn((_target, _profile, draft: ProfileRouteDraft) => {
    candidates = draft.candidates;
    return Promise.resolve({ inspection: inspection() });
  });
  const loadModelPicker = vi.fn<ProfileWorkspaceOptions["loadModelPicker"]>(
    (profile, candidateIndex, candidate) =>
      Promise.resolve({
        choices: ["test/first", "test/second", "test/changed"].map((selector) => ({
          choice: { kind: "model", selector },
          item: { value: selector, label: selector },
          searchText: selector,
          fastModeAvailable: false,
        })),
        current: candidate.model,
        context: { profile, candidateIndex, host: candidate.host, runtime: candidate.runtime },
      }),
  );
  const component = new ProfileWorkspaceComponent({
    theme,
    inspection: inspection(),
    projectTrusted: true,
    target: { kind: "session" },
    parentEffort: "high",
    preferredPiModel: () => "test/first",
    getHeight: () => 24,
    requestRender: vi.fn(),
    close,
    saveDraft,
    loadModelPicker,
    supportedPiEfforts: () => ["low", "high"],
    fastModeAvailable: () => false,
    ...overrides,
  });
  return { component, close, saveDraft, loadModelPicker, candidates: () => candidates, inspection };
};

describe("original profile workspace with faster flows", () => {
  effectTest("skips the candidate page for a single candidate", function* () {
    const h = harness({}, [first]);
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    yield* step(tick);
    expect(h.loadModelPicker).toHaveBeenCalledWith("generalist", 0, first, expect.any(AbortSignal));
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    expect(h.close).not.toHaveBeenCalled();
    h.component.handleInput("p");
    expect(h.close).toHaveBeenCalledWith(expect.objectContaining({ pane: "profiles" }));
  });

  it("retains the original candidate page for multi-candidate routes", () => {
    const h = harness();
    h.component.handleInput("\r");
    h.component.handleInput("p");
    expect(h.close).toHaveBeenCalledWith(expect.objectContaining({ pane: "candidates" }));
    expect(h.loadModelPicker).not.toHaveBeenCalled();
  });

  effectTest("opens model directly from profiles or candidates without extra pages", function* () {
    for (const pane of ["profiles", "candidates"] as const) {
      const h = harness({ initialFocus: pane });
      h.component.handleInput("m");
      yield* step(tick);
      h.component.handleInput("changed");
      h.component.handleInput("\r");
      yield* step(tick);
      expect(h.candidates()[0]?.model).toBe("test/changed");
      expect(h.saveDraft).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves field, Advanced expansion, candidate and pane when leaving for saved sets", () => {
    const h = harness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
    });
    h.component.handleInput("p");
    expect(h.close).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sets",
        profile: "generalist",
        field: "context",
        candidateIndex: 1,
        pane: "fields",
        advancedExpanded: true,
      }),
    );
  });

  it("keeps the focused field when returning through candidate and profile pages", () => {
    const h = harness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
    });
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    h.component.handleInput("k");
    h.component.handleInput("j");
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    h.component.handleInput("p");
    expect(h.close).toHaveBeenCalledWith(
      expect.objectContaining({
        pane: "fields",
        field: "context",
        candidateIndex: 1,
        advancedExpanded: true,
      }),
    );
  });

  it("retains field identity when switching candidates and endpoint jumping", () => {
    const h = harness({ initialFocus: "candidates", initialField: "effort" });
    h.component.handleInput("G");
    h.component.handleInput("p");
    expect(h.close).toHaveBeenCalledWith(
      expect.objectContaining({ field: "effort", candidateIndex: 1 }),
    );
    const localContext = harness({ initialFocus: "candidates", initialField: "context" }, [
      first,
      { ...second, runtime: "claude" },
    ]);
    localContext.component.handleInput("G");
    localContext.component.handleInput("p");
    expect(localContext.close).toHaveBeenCalledWith(
      expect.objectContaining({ field: "model", candidateIndex: 1 }),
    );
  });

  it("offers session saving and target selection without new header controls", () => {
    for (const [key, action] of [
      ["s", "save-session"],
      ["t", "select-target"],
    ]) {
      const h = harness({ initialField: "effort" });
      h.component.handleInput(key!);
      expect(h.close).toHaveBeenCalledWith(
        expect.objectContaining({ action, pane: "profiles", field: "effort" }),
      );
      expect(h.saveDraft).not.toHaveBeenCalled();
    }
  });

  effectTest(
    "adds a fallback only after choosing its model, with cancellation creating nothing",
    function* () {
      const h = harness();
      h.component.handleInput("+");
      yield* step(tick);
      h.component.handleInput("\u001b");
      expect(h.saveDraft).not.toHaveBeenCalled();
      h.component.handleInput("+");
      yield* step(tick);
      h.component.handleInput("changed");
      h.component.handleInput("\r");
      yield* step(tick);
      expect(h.saveDraft).toHaveBeenCalledTimes(1);
      expect(h.candidates()).toEqual([first, second, { ...first, model: "test/changed" }]);
      h.component.handleInput("p");
      expect(h.close).toHaveBeenCalledWith(
        expect.objectContaining({ pane: "fields", field: "model", candidateIndex: 2 }),
      );
    },
  );

  effectTest("opens the original Actions menu directly and adds from there", function* () {
    const h = harness();
    h.component.handleInput("a");
    h.component.handleInput("\r");
    yield* step(tick);
    expect(h.loadModelPicker).toHaveBeenCalled();
    h.component.handleInput("\u001b");
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  effectTest("cancels Run with and model as one edit in either runtime direction", function* () {
    for (const candidate of [first, { ...first, runtime: "claude" as const }]) {
      const h = harness({}, [candidate]);
      h.component.handleInput("r");
      h.component.handleInput(candidate.runtime === "pi" ? "j" : "k");
      h.component.handleInput("\r");
      yield* step(tick);
      h.component.handleInput("\u001b");
      expect(h.saveDraft).not.toHaveBeenCalled();
      expect(h.candidates()).toEqual([candidate]);
    }
  });

  effectTest("keeps shortcuts out of model search input", function* () {
    const h = harness();
    h.component.handleInput("m");
    yield* step(tick);
    h.component.handleInput("s");
    h.component.handleInput("p");
    h.component.handleInput("a");
    h.component.handleInput("+");
    expect(h.close).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.loadModelPicker).toHaveBeenCalledTimes(1);
  });

  effectTest("blocks overlapping edits and navigation during a submitted save", function* () {
    const cell = yield* Deferred.make<ProfileWorkspaceSaveResult>();
    const saveDraft = vi.fn(() => Effect.runPromise(Deferred.await(cell)));
    const h = harness({ saveDraft });
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    for (const key of ["p", "s", "t", "+", "a", "m"]) h.component.handleInput(key);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    yield* Deferred.succeed(cell, { inspection: h.inspection() });
    yield* step(tick);
  });

  effectTest("blocks edits after refresh failure but permits backing out", function* () {
    const saveDraft = vi.fn(() => Promise.resolve({ refreshError: "Reopen required" }));
    const h = harness({ saveDraft }, [first]);
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    yield* step(tick);
    h.component.handleInput("+");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    expect(h.close).toHaveBeenCalledWith(false);
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("enforces the route limit before opening Add", () => {
    const h = harness(
      {},
      Array.from({ length: 32 }, () => first),
    );
    h.component.handleInput("+");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  effectTest("keeps disabled profiles repairable without an extra page", function* () {
    const h = harness({}, []);
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    yield* step(tick);
    expect(h.loadModelPicker).toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });
});
