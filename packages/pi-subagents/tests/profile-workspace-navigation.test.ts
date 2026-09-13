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

describe("fixed-target profile workspace", () => {
  it.each([1, 2])("uses only profiles and fields for %i candidates", (count) => {
    const h = harness({}, [first, second].slice(0, count));
    h.component.handleInput("\r");
    expect(h.component.getPosition().initialFocus).toBe("fields");
    h.component.handleInput("\u001b[C");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    h.component.handleInput("\u001b[D");
    expect(h.component.getPosition().initialFocus).toBe("profiles");
    expect(h.close).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("keeps arrows navigation-only even when configured as confirmation", () => {
    const h = harness({
      initialFocus: "fields",
      matchesKeybinding: (_data, id) => id === "tui.select.confirm",
    });
    for (const key of ["\u001b[C", "\u001b[B", "\u001b[A", "\u001b[D"])
      h.component.handleInput(key);
    expect(h.component.getPosition().initialFocus).toBe("profiles");
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
  });

  it("scrolls help on short terminals without moving the editor selection", () => {
    const h = harness({ getHeight: () => 8 });
    const position = h.component.getPosition();
    h.component.handleInput("?");
    const firstPage = h.component.render(48);
    h.component.handleInput("G");
    expect(h.component.render(48)).not.toEqual(firstPage);
    expect(h.component.getPosition()).toEqual(position);
    h.component.handleInput("g");
    h.component.handleInput("g");
    expect(h.component.render(48)).toEqual(firstPage);
    h.component.handleInput("\u001b");
    expect(h.component.hasOverlay).toBe(false);
  });

  it("offers session saving through a shortcut and a selectable row only for Current Session", () => {
    const session = harness();
    session.component.handleInput("s");
    expect(session.close).toHaveBeenCalledWith(expect.objectContaining({ action: "save-session" }));
    const row = harness({ initialFocus: "fields" });
    row.component.handleInput("G");
    row.component.handleInput("\r");
    expect(row.close).toHaveBeenCalledWith(expect.objectContaining({ action: "save-session" }));
    const saved = harness({
      target: { kind: "profile-set", set: { scope: "global", name: "default" } },
      initialFocus: "fields",
    });
    saved.component.handleInput("s");
    saved.component.handleInput("G");
    expect(saved.close).not.toHaveBeenCalled();
    expect(saved.component.getPosition().initialField).not.toBe("save-session");
  });

  effectTest("moves candidate identity together with its remembered advanced fields", function* () {
    const h = harness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
    });
    h.component.handleInput("a");
    h.component.handleInput("j");
    h.component.handleInput("j");
    h.component.handleInput("\r");
    yield* step(tick);
    expect(h.candidates()).toEqual([second, first]);
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 0,
      initialField: "context",
      initialAdvancedExpanded: true,
    });
    h.component.handleInput("]");
    expect(h.component.getPosition().initialAdvancedExpanded).toBe(false);
    h.component.handleInput("[");
    expect(h.component.getPosition()).toMatchObject({
      initialField: "context",
      initialAdvancedExpanded: true,
    });
  });

  it("uses j/k and horizontal arrows for panes without moving rows or editing", () => {
    const h = harness();
    const initial = h.component.getPosition();
    for (const key of ["j", "j", "\u001b[C"]) {
      h.component.handleInput(key);
      expect(h.component.getPosition()).toMatchObject({
        initialFocus: "fields",
        initialProfile: initial.initialProfile,
        initialField: initial.initialField,
      });
    }
    for (const key of ["k", "k", "\u001b[D"]) {
      h.component.handleInput(key);
      expect(h.component.getPosition()).toMatchObject({
        initialFocus: "profiles",
        initialProfile: initial.initialProfile,
        initialField: initial.initialField,
      });
    }
    expect(h.close).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
  });

  it("remembers each profile and candidate's field and Advanced state", () => {
    const h = harness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
    });
    h.component.handleInput("[");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 0,
      initialField: "model",
      initialAdvancedExpanded: false,
    });
    h.component.handleInput("]");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 1,
      initialField: "context",
      initialAdvancedExpanded: true,
    });
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b[A");
    h.component.handleInput("\u001b[B");
    h.component.handleInput("\r");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 1,
      initialField: "context",
      initialAdvancedExpanded: true,
      initialFocus: "fields",
    });
  });

  it("walks continuously through candidate fields without a candidate page", () => {
    const h = harness({ initialFocus: "fields" });
    h.component.handleInput("G");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 1,
      initialField: "save-session",
    });
    h.component.handleInput("g");
    h.component.handleInput("g");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 0,
      initialField: "model",
    });
  });

  it("keeps help open until dismissed and consumes shortcuts without edits", () => {
    const h = harness();
    const position = h.component.getPosition();
    h.component.handleInput("?");
    expect(h.component.hasOverlay).toBe(true);
    for (const key of ["m", "+", "j", "\t"]) h.component.handleInput(key);
    expect(h.component.hasOverlay).toBe(true);
    expect(h.component.getPosition()).toEqual(position);
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    expect(h.component.hasOverlay).toBe(false);
    expect(h.close).not.toHaveBeenCalled();
  });

  effectTest("opens the model picker directly from either focus zone", function* () {
    for (const initialFocus of ["profiles", "fields"] as const) {
      const h = harness({ initialFocus });
      h.component.handleInput("m");
      yield* step(tick);
      h.component.handleInput("changed");
      h.component.handleInput("\r");
      yield* step(tick);
      expect(h.candidates()[0]?.model).toBe("test/changed");
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
      expect(h.component.getPosition()).toMatchObject({
        initialFocus: "fields",
        initialField: "model",
        initialCandidateIndex: 2,
      });
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
    yield* step(tick);
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
