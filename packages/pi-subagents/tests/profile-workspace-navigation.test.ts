import { deferredPromise } from "pi-cosmic-core/testing";
import { effectTest, step } from "./support/effect-test.ts";
import { describe, expect, it, vi } from "vitest";
import type { ProfileWorkspaceSaveResult } from "../src/settings/profile-workspace.ts";
import { chooseFromPage, settleTurn, workspaceHarness } from "./fixtures/profile-workspace.ts";
import { profileCandidate } from "./fixtures/profiles.ts";

const first = profileCandidate("test/first");
const second = profileCandidate("test/second");

describe("fixed-target profile workspace", () => {
  it("keeps arrows navigation-only even when configured as confirmation", () => {
    const h = workspaceHarness({
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
    const h = workspaceHarness({ getHeight: () => 8 });
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
    const session = workspaceHarness();
    session.component.handleInput("s");
    expect(session.saveSession).toHaveBeenCalled();
    const row = workspaceHarness({ initialFocus: "profiles" });
    row.component.handleInput("G");
    row.component.handleInput("\r");
    expect(row.saveSession).toHaveBeenCalled();
    const saved = workspaceHarness({
      target: { kind: "profile-set", set: { scope: "global", name: "default" } },
      initialFocus: "profiles",
    });
    saved.component.handleInput("s");
    saved.component.handleInput("G");
    expect(saved.saveSession).not.toHaveBeenCalled();
    expect(saved.close).not.toHaveBeenCalled();
    expect(saved.component.getPosition().initialSaveFocused).toBe(false);
  });

  it("keeps session-save focus separate from the selected profile and candidate field", () => {
    const h = workspaceHarness({
      initialFocus: "fields",
      initialCandidateIndex: 1,
      initialField: "context",
    });
    h.component.handleInput("h");
    h.component.handleInput("j"); // Save follows generalist in the profile pane.
    expect(h.component.getPosition()).toMatchObject({
      initialSaveFocused: true,
      initialProfile: "generalist",
      initialCandidateIndex: 1,
      initialField: "context",
    });
    h.component.handleInput("a");
    expect(h.component.hasOverlay).toBe(false);
    h.component.handleInput("l");
    expect(h.component.getPosition().initialField).toBe("context");
    expect(h.saveSession).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.component.handleInput("h");
    h.component.handleInput("k");
    expect(h.component.getPosition()).toMatchObject({
      initialSaveFocused: false,
      initialProfile: "generalist",
      initialField: "context",
    });
    h.component.handleInput("G");
    const restored = workspaceHarness(h.component.getPosition());
    expect(restored.component.getPosition()).toMatchObject({
      initialSaveFocused: true,
      initialField: "context",
    });
    restored.component.handleInput("\r");
    expect(restored.saveSession).toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(restored.saveDraft).not.toHaveBeenCalled();
  });

  effectTest("moves candidate identity together with its remembered advanced fields", function* () {
    const h = workspaceHarness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
    });
    chooseFromPage(h.component, "a", "move-up");
    yield* step(settleTurn);
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

  it("uses h/l and horizontal arrows for panes without moving rows or editing", () => {
    const h = workspaceHarness();
    const initial = h.component.getPosition();
    for (const key of ["l", "l", "\u001b[C"]) {
      h.component.handleInput(key);
      expect(h.component.getPosition()).toMatchObject({
        initialFocus: "fields",
        initialProfile: initial.initialProfile,
        initialField: initial.initialField,
      });
    }
    for (const key of ["h", "h", "\u001b[D"]) {
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

  it("uses j/k to move rows within each pane without editing", () => {
    const h = workspaceHarness();
    const initial = h.component.getPosition();
    h.component.handleInput("k");
    expect(h.component.getPosition().initialProfile).not.toBe(initial.initialProfile);
    expect(h.component.getPosition().initialFocus).toBe("profiles");
    h.component.handleInput("j");
    expect(h.component.getPosition().initialProfile).toBe(initial.initialProfile);
    h.component.handleInput("l");
    h.component.handleInput("j");
    expect(h.component.getPosition()).toMatchObject({
      initialFocus: "fields",
      initialField: "effort",
    });
    h.component.handleInput("k");
    expect(h.component.getPosition()).toMatchObject({
      initialFocus: "fields",
      initialField: "model",
    });
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
  });

  it("remembers each profile's candidate, field, and Advanced state", () => {
    const h = workspaceHarness({
      initialFocus: "fields",
      initialField: "context",
      initialCandidateIndex: 1,
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

  it("remembers profile controls separately from each candidate's field", () => {
    const h = workspaceHarness({
      initialFocus: "fields",
      initialCandidateIndex: 1,
      initialField: "context",
    });
    h.component.handleInput("G");
    expect(h.component.getPosition()).toMatchObject({
      initialField: "reset",
      initialCandidateIndex: 1,
    });
    h.component.handleInput("k");
    expect(h.component.getPosition().initialField).toBe("add");
    h.component.handleInput("h");
    h.component.handleInput("k");
    h.component.handleInput("j");
    h.component.handleInput("l");
    expect(h.component.getPosition().initialField).toBe("add");
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
    h.component.handleInput("g");
    h.component.handleInput("g");
    expect(h.component.getPosition()).toMatchObject({
      initialCandidateIndex: 0,
      initialField: "model",
    });
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it("keeps help open until dismissed and consumes shortcuts without edits", () => {
    const h = workspaceHarness();
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
      const h = workspaceHarness({ initialFocus });
      h.component.handleInput("m");
      yield* step(settleTurn);
      h.component.handleInput("changed");
      h.component.handleInput("\r");
      yield* step(settleTurn);
      expect(h.candidates()[0]?.model).toBe("test/changed");
    }
  });

  effectTest(
    "adds a fallback only after choosing its model, with cancellation creating nothing",
    function* () {
      const h = workspaceHarness();
      h.component.handleInput("+");
      yield* step(settleTurn);
      h.component.handleInput("\u001b");
      expect(h.saveDraft).not.toHaveBeenCalled();
      h.component.handleInput("+");
      yield* step(settleTurn);
      h.component.handleInput("changed");
      h.component.handleInput("\r");
      yield* step(settleTurn);
      expect(h.saveDraft).toHaveBeenCalledTimes(1);
      expect(h.candidates()).toEqual([first, second, { ...first, model: "test/changed" }]);
      expect(h.component.getPosition()).toMatchObject({
        initialFocus: "fields",
        initialField: "model",
        initialCandidateIndex: 2,
      });
    },
  );

  effectTest("adds from profile controls without exposing Add in candidate menus", function* () {
    const h = workspaceHarness();
    chooseFromPage(h.component, "a", "add");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    h.component.handleInput("l");
    h.component.handleInput("G");
    h.component.handleInput("k");
    expect(h.component.getPosition().initialField).toBe("add");
    h.component.handleInput("a"); // A profile control must not manage the last candidate.
    expect(h.component.hasOverlay).toBe(false);
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(h.loadModelPicker).toHaveBeenCalled();
    h.component.handleInput("\u001b");
    expect(h.component.getPosition().initialField).toBe("add");
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  effectTest("cancels Run with and model as one edit in either runtime direction", function* () {
    for (const candidate of [first, { ...first, runtime: "claude" as const }]) {
      const h = workspaceHarness({}, [candidate]);
      h.component.handleInput("r");
      h.component.handleInput(candidate.runtime === "pi" ? "j" : "k");
      h.component.handleInput("\r");
      yield* step(settleTurn);
      h.component.handleInput("\u001b");
      expect(h.saveDraft).not.toHaveBeenCalled();
      expect(h.candidates()).toEqual([candidate]);
    }
  });

  effectTest("keeps shortcuts out of model search input", function* () {
    const h = workspaceHarness();
    h.component.handleInput("m");
    yield* step(settleTurn);
    h.component.handleInput("s");
    h.component.handleInput("p");
    h.component.handleInput("a");
    h.component.handleInput("+");
    expect(h.close).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
    expect(h.loadModelPicker).toHaveBeenCalledTimes(1);
  });

  effectTest("blocks overlapping edits and navigation during a submitted save", function* () {
    const cell = deferredPromise<ProfileWorkspaceSaveResult>();
    const saveDraft = vi.fn(() => cell.promise);
    const h = workspaceHarness({ saveDraft });
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    for (const key of ["p", "s", "t", "+", "a", "m"]) h.component.handleInput(key);
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    cell.resolve({ inspection: h.inspection() });
    yield* step(settleTurn);
  });

  effectTest("blocks edits after refresh failure but permits backing out", function* () {
    const saveDraft = vi.fn(() => Promise.resolve({ refreshError: "Reopen required" }));
    const h = workspaceHarness({ saveDraft }, [first]);
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    h.component.handleInput("+");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    expect(h.close).toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("enforces the route limit before opening Add", () => {
    const h = workspaceHarness(
      {},
      Array.from({ length: 32 }, () => first),
    );
    h.component.handleInput("+");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  effectTest("keeps disabled profiles repairable without an extra page", function* () {
    const h = workspaceHarness({}, []);
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(h.loadModelPicker).toHaveBeenCalled();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });
});
