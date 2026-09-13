import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import type { JsonObject } from "pi-cosmic-core";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import {
  defaultRouteCandidate,
  loadProfileRouteDraft,
  type ProfileRouteDraft,
  type ProfileWorkspaceTarget,
} from "../src/settings/profile-route-editor.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";

const session: ProfileWorkspaceTarget = { kind: "session" };
const saved = (name = "one", scope: "global" | "project" = "global"): ProfileWorkspaceTarget => ({
  kind: "profile-set",
  set: { scope, name },
});
const candidate = defaultRouteCandidate("worker");
const explicit: ProfileRouteDraft = { kind: "explicit", candidates: [candidate] };
const disabled: ProfileRouteDraft = { kind: "disabled", candidates: [] };
const json = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));
const inspect = (
  global: JsonObject = { version: 6, profileSets: { one: { profiles: {} } } },
  seed?: SessionProfileOverrideSeed,
  project?: JsonObject,
) =>
  makeProfileSettingsInspection(
    {
      globalDocument: global,
      projectDocument: project,
      projectTrusted: true,
    },
    seed,
  );
const withSession = (
  base: ReturnType<typeof inspect>,
  draft: ProfileRouteDraft,
  revision: number,
) =>
  inspect(
    base.globalDocument,
    {
      baseline: base.session.baseline,
      revision,
      overrides: draft.kind === "inherit" ? {} : { worker: { candidates: draft.candidates } },
    },
    base.projectDocument,
  );
// Test candidates allow missing fields and invalid enum strings before configuration decoding.
type CandidateFixture = Partial<
  Record<keyof ProfileCandidate | "fastMode", string | boolean | undefined>
>;
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

  it("does not mark pre-existing session overrides and restores them instead of baseline", () => {
    const opening = inspect(undefined, { revision: 8, overrides: { worker: { candidates: [] } } });
    const visit = new ProfileEditVisit(opening);
    expect(visit.isEdited(session, "worker", opening)).toBe(false);
    const after = withSession(opening, explicit, 9);
    save(visit, session, "worker", opening, after, explicit);
    expect(visit.undoDraft(session, "worker", after)).toMatchObject({ draft: disabled });
  });

  it("restores absence even when the inherited project route was invalid", () => {
    const opening = inspect(
      { ...doc({ ...candidate, effort: "nonsense" }), defaultProfileSet: "one" },
      undefined,
      doc(undefined),
    );
    const target = saved("one", "project");
    const visit = new ProfileEditVisit(opening);
    const after = inspect(opening.globalDocument, undefined, doc("disabled"));
    save(visit, target, "worker", opening, after, disabled);
    expect(visit.undoDraft(target, "worker", after)).toMatchObject({
      draft: { kind: "inherit", candidates: [] },
    });
  });

  it("rejects restoration of a malformed own declaration", () => {
    const opening = inspect(doc({ ...candidate, effort: "nonsense" }));
    const visit = new ProfileEditVisit(opening);
    const after = inspect(doc("disabled"));
    save(visit, saved(), "worker", opening, after, disabled);
    expect(visit.undoDraft(saved(), "worker", after)).toHaveProperty("error");
    expect(visit.isEdited(saved(), "worker", after)).toBe(false);
  });

  it.each([4, 5])("clears legacy v%s undo and preserves sibling migration authority", (version) => {
    const { openaiFastMode: _fast, closeOnReport: _close, ...sparse } = candidate;
    for (const fastMode of [undefined, false, true]) {
      const rawCandidate: typeof sparse & { fastMode?: boolean } = { ...sparse };
      const migratedCandidate: typeof sparse & { openaiFastMode?: boolean } = { ...sparse };
      if (fastMode !== undefined) rawCandidate.fastMode = fastMode;
      if (fastMode === true) migratedCandidate.openaiFastMode = true;
      const raw = [rawCandidate];
      const migrated = [migratedCandidate];
      const opening = inspect(json({ version, profiles: { worker: raw } }));
      const target = saved("default");
      const visit = new ProfileEditVisit(opening);
      const seed = { baseline: opening.session.baseline, revision: 0, overrides: {} };
      const after = inspect(doc("disabled", "default"), seed);
      expect(save(visit, target, "worker", opening, after, disabled)).toBe(true);
      expect(visit.isEdited(target, "worker", after)).toBe(true);
      const undo = visit.undoDraft(target, "worker", after);
      if (!("draft" in undo)) throw new Error(undo.error);
      expect(undo.restore).toEqual({ sourceVersion: version, declaration: raw });
      const restored = inspect(doc(migrated, "default"), seed);
      expect(save(visit, target, "worker", after, restored, undo.draft)).toBe(true);
      expect(visit.isEdited(target, "worker", restored)).toBe(false);

      // A different route's save migrates worker without changing its declaration.
      const siblingVisit = new ProfileEditVisit(opening);
      siblingVisit.reconcile(restored);
      expect(save(siblingVisit, target, "worker", restored, after, disabled)).toBe(true);
      expect(siblingVisit.isEdited(target, "worker", after)).toBe(true);
    }
  });

  it("keeps Project undo through Global edits while inheriting, but rejects Project drift", () => {
    const opening = inspect(doc(candidate), undefined, doc(candidate));
    const target = saved("one", "project");
    const visit = new ProfileEditVisit(opening);
    const inherited = inspect(opening.globalDocument, undefined, doc(undefined));
    expect(
      save(visit, target, "worker", opening, inherited, { kind: "inherit", candidates: [] }),
    ).toBe(true);
    const changedGlobal = inspect(doc("disabled"), undefined, inherited.projectDocument);
    expect(save(visit, saved(), "worker", inherited, changedGlobal, disabled)).toBe(true);
    expect(visit.isEdited(target, "worker", changedGlobal)).toBe(true);
    expect(visit.undoDraft(target, "worker", changedGlobal)).toMatchObject({ draft: explicit });
    expect(save(visit, saved(), "worker", changedGlobal, inherited, explicit)).toBe(true);
    expect(visit.isEdited(target, "worker", inherited)).toBe(true);
    const external = inspect(inherited.globalDocument, undefined, doc("disabled"));
    expect(visit.isEdited(target, "worker", external)).toBe(false);
    expect(visit.undoDraft(target, "worker", external)).toHaveProperty("error");
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

  it("captures initial sets before opening them and transfers only owned renames", () => {
    const opening = inspect();
    const visit = new ProfileEditVisit(opening);
    const own = inspect(doc(candidate));
    save(visit, saved(), "worker", opening, own, explicit);
    const renamed = inspect(doc(candidate, "two"));
    visit.renameTarget(saved(), saved("two"), renamed);
    expect(visit.isEdited(saved("two"), "worker", renamed)).toBe(true);
    expect(visit.undoDraft(saved("two"), "worker", renamed)).toMatchObject({
      draft: { kind: "reset" },
    });
    visit.deleteTarget(saved("two"));
    visit.captureTarget(saved("two"), renamed);
    expect(visit.isEdited(saved("two"), "worker", renamed)).toBe(false);
    visit.reconcile(inspect(doc(undefined, "other")));
    visit.captureTarget(saved("two"), renamed);
    expect(visit.undoDraft(saved("two"), "worker", renamed)).toHaveProperty("error");
  });

  it("retains raw singleton arrays and optional field absence defensively", () => {
    const { closeOnReport: _close, openaiFastMode: _fast, ...sparse } = candidate;
    const raw = [{ ...sparse, openaiFastMode: false }];
    const opening = inspect(doc(raw));
    const visit = new ProfileEditVisit(opening);
    const after = inspect(doc("disabled"));
    save(visit, saved(), "worker", opening, after, disabled);
    const undo = visit.undoDraft(saved(), "worker", after);
    expect(undo).toMatchObject({ restore: { sourceVersion: 6, declaration: raw } });
    if (!("draft" in undo)) throw new Error(undo.error);
    expect(undo.restore?.declaration).not.toBe(raw);
    if (Array.isArray(undo.restore?.declaration)) undo.restore.declaration.push("disabled");
    expect(visit.undoDraft(saved(), "worker", after)).toMatchObject({
      restore: { declaration: raw },
    });
  });

  it("requires commit evidence and rejects external changes between commit and refresh", () => {
    const opening = inspect();
    const committed = inspect(doc(candidate));
    const refreshed = inspect(doc("disabled"));
    const visit = new ProfileEditVisit(opening);
    expect(visit.recordSave(saved(), "worker", opening, committed, explicit)).toBe(false);
    const fresh = new ProfileEditVisit(opening);
    expect(
      fresh.recordSave(saved(), "worker", opening, refreshed, explicit, {
        kind: "saved",
        document: json(doc(candidate)),
      }),
    ).toBe(false);
    expect(fresh.isEdited(saved(), "worker", refreshed)).toBe(false);
    expect(fresh.undoDraft(saved(), "worker", refreshed)).toHaveProperty("error");
  });

  it("does not collapse v6 array shape or optional false into an exact restore", () => {
    const { openaiFastMode: _fast, closeOnReport: _close, ...sparse } = candidate;
    const opening = inspect(doc([sparse]));
    for (const changed of [
      sparse,
      [{ ...sparse, openaiFastMode: false }],
      [{ ...sparse, closeOnReport: true }],
    ]) {
      const visit = new ProfileEditVisit(opening);
      const after = inspect(doc(changed));
      expect(
        save(
          visit,
          saved(),
          "worker",
          opening,
          after,
          loadProfileRouteDraft(after, saved(), "worker"),
        ),
      ).toBe(true);
      expect(visit.isEdited(saved(), "worker", after)).toBe(true);
    }
  });

  it("does not treat document key order as an external route edit", () => {
    const opening = inspect();
    const visit = new ProfileEditVisit(opening);
    const after = inspect(doc(candidate));
    save(visit, saved(), "worker", opening, after, explicit);
    const reordered = Object.fromEntries(Object.entries(candidate).reverse());
    expect(visit.isEdited(saved(), "worker", inspect(doc(reordered)))).toBe(true);
  });

  it("starts newly discovered targets at first open and resets applied session baselines", () => {
    const opening = inspect();
    const visit = new ProfileEditVisit(opening);
    const discovered = inspect(doc(candidate, "new"));
    visit.captureTarget(saved("new"), discovered);
    const after = inspect(doc("disabled", "new"));
    save(visit, saved("new"), "worker", discovered, after, disabled);
    expect(visit.undoDraft(saved("new"), "worker", after)).toMatchObject({ draft: explicit });
    const own = withSession(after, disabled, 1);
    save(visit, session, "worker", after, own, disabled);
    const applied = inspect({ ...doc(candidate), defaultProfileSet: "one" });
    visit.reconcile(applied);
    expect(visit.isEdited(session, "worker", applied)).toBe(false);
    expect(visit.undoDraft(session, "worker", applied)).toHaveProperty("error");
    visit.resetSession(own);
    expect(visit.isEdited(session, "worker", own)).toBe(false);
  });
});
