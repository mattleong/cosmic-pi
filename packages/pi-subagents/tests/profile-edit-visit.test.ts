import { describe, expect, it } from "vitest";
import type { JsonObject } from "pi-cosmic-core";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import {
  defaultRouteCandidate,
  type ProfileRouteDraft,
  type ProfileWorkspaceTarget,
} from "../src/settings/profile-route-editor.ts";
import {
  jsonObject as json,
  profileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";

const saved = (name = "one", scope: "global" | "project" = "global"): ProfileWorkspaceTarget => ({
  kind: "profile-set",
  set: { scope, name },
});
const candidate = defaultRouteCandidate("worker");
const explicit: ProfileRouteDraft = { kind: "explicit", candidates: [candidate] };
const disabled: ProfileRouteDraft = { kind: "disabled", candidates: [] };
const inspect = (
  global: JsonObject = { version: 6, profileSets: { one: { profiles: {} } } },
  seed?: SessionProfileOverrideSeed,
  project?: JsonObject,
) =>
  profileSettingsInspection(
    {
      globalDocument: global,
      projectDocument: project,
      projectTrusted: true,
    },
    seed,
  );
type CandidateFixture = Partial<Record<keyof ProfileCandidate, string | boolean | undefined>>;
const doc = (
  route: CandidateFixture | ReadonlyArray<CandidateFixture> | "disabled" | undefined,
  name = "one",
): JsonObject =>
  json({
    version: 6,
    profileSets: {
      [name]: { profiles: route === undefined ? {} : { worker: route } },
    },
  });

const save = (
  visit: ProfileEditVisit,
  target: ProfileWorkspaceTarget,
  profile: "worker",
  before: ReturnType<typeof inspect>,
  after: ReturnType<typeof inspect>,
  draft: ProfileRouteDraft,
) => {
  const document =
    target.kind === "profile-set" && target.set.scope === "project"
      ? after.projectDocument
      : after.globalDocument;
  if (!document) throw new Error("Missing fixture document");
  return visit.recordSave(
    target,
    profile,
    before,
    after,
    draft,
    target.kind === "session"
      ? { kind: "session", snapshot: after.session }
      : { kind: "saved", document },
  );
};

describe("profile editing visit", () => {
  it("undoes two own edits to the exact opening ordered route and copies snapshots", () => {
    const route = [candidate, { ...candidate, model: "parent", effort: "low" as const }];
    const opening = inspect(doc(route));
    const visit = new ProfileEditVisit(opening);
    const first = inspect(doc("disabled"));
    expect(save(visit, saved(), "worker", opening, first, disabled)).toBe(true);
    const second = inspect(doc(candidate));
    save(visit, saved(), "worker", first, second, explicit);
    expect(visit.isEdited(saved(), "worker", second)).toBe(true);
    expect(visit.undoDraft(saved(), "worker", second)).toMatchObject({
      draft: { kind: "explicit", candidates: route },
    });
    const undo = visit.undoDraft(saved(), "worker", second);
    if (!("draft" in undo)) throw new Error(undo.error);
    expect(undo.draft.candidates).not.toBe(route);
    save(visit, saved(), "worker", second, opening, undo.draft);
    expect(visit.isEdited(saved(), "worker", opening)).toBe(false);
  });

  it("invalidates undo on external changes and never attributes a conflicting save", () => {
    const opening = inspect();
    const visit = new ProfileEditVisit(opening);
    const own = inspect(doc(candidate));
    save(visit, saved(), "worker", opening, own, explicit);
    const external = inspect(doc("disabled"));
    expect(visit.undoDraft(saved(), "worker", external)).toHaveProperty("error");
    expect(visit.isEdited(saved(), "worker", external)).toBe(false);
    const fresh = new ProfileEditVisit(opening);
    expect(save(fresh, saved(), "worker", opening, external, explicit)).toBe(false);
    expect(fresh.isEdited(saved(), "worker", external)).toBe(false);
  });
});
