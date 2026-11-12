import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import { ProfileDashboardComponent } from "../src/settings/profile-dashboard-component.ts";
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
import { settleTurn, workspaceHarness, workspaceInspection } from "./fixtures/profile-workspace.ts";

const ANY_POSITION = /more (above|below)|\d+–\d+ of \d+/u;

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

const dashboard = (
  options: {
    readonly seed?: SessionProfileOverrideSeed;
    readonly width?: number;
    readonly height?: number;
  } = {},
) => {
  const value = savedInspection(options.seed);
  const actions = subagentCommandActionsFixture({
    inspectProfiles: vi.fn(() => Promise.resolve(value)),
    createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
  });
  const width = options.width ?? 180;
  const component = new ProfileDashboardComponent({
    ctx: extensionContextFixture({ isProjectTrusted: () => true }),
    actions,
    isCurrent: () => true,
    onInspection: vi.fn(),
    awaitDialog: (register) =>
      Effect.runPromise(
        Effect.callback((resume) => {
          const cleanup = register((result) => resume(Effect.succeed(result)));
          return Effect.sync(cleanup);
        }),
      ),
    workspace: {
      theme: plainTheme,
      inspection: value,
      target: { kind: "session" },
      initialProfile: "scout",
      parentEffort: "high",
      getHeight: () => options.height ?? 40,
      requestRender: vi.fn(),
      close: vi.fn(),
      saveDraft: vi.fn<ProfileWorkspaceOptions["saveDraft"]>(() =>
        Promise.resolve({ inspection: value }),
      ),
      loadModelPicker: () => Promise.reject(new Error("unused")),
      supportedPiEfforts: () => undefined,
    },
  });
  component.focused = true;
  return {
    component,
    actions,
    press: (...keys: string[]) => {
      for (const key of keys) component.handleInput(key);
    },
    screen: () => Arr.join(component.render(width), "\n"),
    lines: () => component.render(width),
  };
};

const markers = (screen: string) => Arr.filter(Array.from(screen), (char) => char === "●").length;

const changedScout = { candidates: [profileCandidate("test/changed")] };

describe("profile dashboard layout", () => {
  it("names the scroll position of both panes when neither fits", () => {
    const d = dashboard({ width: 72, height: 20 });
    d.press("l");
    const lines = d.lines();
    const headings = Arr.filter(lines, (line) => ANY_POSITION.test(line));
    // The profile list and the fields pane each name what they scrolled off.
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(d.screen()).not.toContain("generalist");
  });

  it("stacks both panes on a tall narrow frame and shows one on a short one", () => {
    const tall = dashboard({ width: 57, height: 46 });
    expect(tall.screen()).toContain("generalist");
    expect(tall.screen()).toContain("File access");
    const short = dashboard({ width: 57, height: 20 });
    expect(short.screen()).toContain("generalist");
    expect(short.screen()).not.toContain("File access");
  });

  it("keeps the profile list in view while a short choice list is open", () => {
    const d = dashboard();
    d.press("e");
    const screen = d.screen();
    expect(screen).toContain("generalist");
    expect(screen).toMatch(/\(•\)/u);
    const single = dashboard({ width: 57, height: 20 });
    single.press("e");
    expect(single.screen()).toMatch(/\(•\)/u);
    expect(single.screen()).not.toContain("generalist");
  });
});

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
    expect(d.screen()).toMatch(/\bs Save\b/u);
    d.press("\t", "j", "\r", "?");
    expect(markers(d.screen())).toBe(0);
    expect(d.screen()).not.toMatch(/\bs Save\b/u);
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
    const hints = () => Arr.join(h.component.render(120), "\n");
    expect(hints()).not.toMatch(/\bu Undo\b/u);
    // With nothing to undo, `u` asks nothing.
    h.component.handleInput("u");
    expect(h.component.hasOverlay).toBe(false);
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(hints()).toMatch(/\bu Undo\b/u);
    h.component.handleInput("u");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(candidates).toEqual([profileCandidate("test/first"), profileCandidate("test/second")]);
    expect(hints()).not.toMatch(/\bu Undo\b/u);
  });
});
