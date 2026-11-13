import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import type { ProfileWorkspaceOptions } from "../src/settings/profile-workspace.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";
import { profileSetPickerEntries } from "../src/settings/ui/profile-set-picker-model.ts";
import { sessionFooterContribution } from "../src/ui/session-footer.ts";
import { profileWorkspaceRows } from "../src/settings/ui/profile-workspace-model.ts";
import {
  profileSettingsInspection,
  subagentCommandActionsFixture,
} from "./fixtures/profile-settings-inspection.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import { effectTest, step } from "./support/effect-test.ts";
import {
  dashboardHarness,
  settleTurn,
  workspaceHarness,
  workspaceInspection,
} from "./fixtures/profile-workspace.ts";

const savedInspection = (seed?: SessionProfileOverrideSeed) =>
  profileSettingsInspection(
    {
      globalDocument: {
        version: 6,
        defaultProfileSet: "base",
        profileSets: {
          base: {
            profiles: {
              scout: [declaredCandidate("test/scout"), declaredCandidate("test/scout-backup")],
            },
          },
          other: { profiles: {} },
        },
      },
      projectTrusted: true,
    },
    seed,
  );

const dashboard = (options: { readonly seed?: SessionProfileOverrideSeed } = {}) => {
  const inspection = savedInspection(options.seed);
  const actions = subagentCommandActionsFixture({
    inspectProfiles: vi.fn(() => Promise.resolve(inspection)),
    createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
  });
  const harness = dashboardHarness({
    inspection,
    actions,
    workspace: { initialProfile: "scout" },
  });
  return {
    ...harness,
    actions,
    screen: () => Arr.join(harness.component.render(180), "\n"),
    lines: () => harness.component.render(180),
  };
};

const markers = (screen: string) => Arr.filter(Array.from(screen), (char) => char === "●").length;

const changedScout = { candidates: [profileCandidate("test/changed")] };

describe("session changes against the set the session is based on", () => {
  it("marks only profiles that differ from the base set and counts them in the status row", () => {
    const unchanged = dashboard();
    expect(markers(unchanged.screen())).toBe(0);
    const changed = dashboard({
      seed: { revision: 1, overrides: { scout: changedScout, worker: changedScout } },
    });
    expect(markers(changed.screen())).toBe(2);
    const status = changed.lines()[1] ?? "";
    expect(status).toContain("Global/base");
    expect(status).toContain("2");
    expect(status).not.toEqual(unchanged.lines()[1]);
  });

  it("treats an override equal to the base set as unchanged", () => {
    const same = {
      candidates: [profileCandidate("test/scout"), profileCandidate("test/scout-backup")],
    };
    const d = dashboard({ seed: { revision: 1, overrides: { scout: same } } });
    expect(markers(d.screen())).toBe(0);
  });

  it("marks the footer as edited exactly when the dashboard counts a change", () => {
    const footer = (seed?: SessionProfileOverrideSeed) =>
      sessionFooterContribution(savedInspection(seed).session).text;
    const same = {
      candidates: [profileCandidate("test/scout"), profileCandidate("test/scout-backup")],
    };
    expect(footer({ revision: 1, overrides: { scout: same } })).toBe(footer());
    expect(footer({ revision: 1, overrides: { scout: changedScout } })).not.toBe(footer());
  });

  it("shows no marker and offers no save in a saved set's editor", () => {
    const d = dashboard({ seed: { revision: 1, overrides: { scout: changedScout } } });
    d.press("\t", "j", "\r", "?");
    expect(markers(d.screen())).toBe(0);
    d.press("?");
    const before = d.screen();
    d.press("s");
    expect(d.screen()).toEqual(before);
    expect(d.actions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
  });
});

describe("saved sets", () => {
  it("marks the set the session is based on", () => {
    const entries = profileSetPickerEntries(savedInspection(), true);
    const inUse = Arr.filter(entries, (entry) => entry.kind === "set" && entry.inUse);
    expect(Arr.map(inUse, (entry) => entry.label)).toEqual(["base"]);
  });
});

describe("fields pane", () => {
  it("lists only settings, and an empty profile offers one actionable row", () => {
    const rows = profileWorkspaceRows(
      { kind: "explicit", candidates: [profileCandidate("test/a"), profileCandidate("test/b")] },
      "scout",
      "high",
      undefined,
      new Set(),
    );
    expect(Arr.every(rows, (row) => row.scope === "candidate")).toBe(true);
    const empty = profileWorkspaceRows(
      { kind: "disabled", candidates: [] },
      "scout",
      "high",
      undefined,
      new Set(),
    );
    expect(empty).toHaveLength(1);
    expect(empty[0]?.fixed).toBe(false);
  });

  it("adds a model from an empty profile's only row", () => {
    const h = workspaceHarness({ initialFocus: "fields" }, []);
    h.component.handleInput("\r");
    expect(h.loadModelPicker).toHaveBeenCalledOnce();
  });

  effectTest("offers Undo only once there is a change from this visit to undo", function* () {
    let candidates = [profileCandidate("test/first"), profileCandidate("test/second")];
    const inspection = () =>
      workspaceInspection({ revision: 1, overrides: { generalist: { candidates } } });
    const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>((_target, _profile, draft) => {
      candidates = [...draft.candidates];
      const next = inspection();
      return Promise.resolve({
        inspection: next,
        receipt: { kind: "session", snapshot: next.session },
      });
    });
    const h = workspaceHarness({ initialFocus: "fields", inspection: inspection(), saveDraft });
    // With nothing to undo, `u` asks nothing.
    h.component.handleInput("u");
    expect(h.component.hasOverlay).toBe(false);
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledOnce();
    h.component.handleInput("u");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(candidates).toEqual([profileCandidate("test/first"), profileCandidate("test/second")]);
  });
});
