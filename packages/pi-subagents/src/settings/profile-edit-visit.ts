import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { isJsonObject, type JsonObject } from "pi-cosmic-core/platform/json-document";
import { subagentConfigDecoder } from "../config/schema.ts";
import { captureRestoreDeclaration, stableJson } from "../config/profile-restore.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import { PROFILE_IDS, cloneProfileCandidates, type ProfileId } from "../profiles/model.ts";
import {
  declaredRouteForDraft,
  hasOwnProfileRouteDeclaration,
  loadProfileRouteDraft,
  profileTargetKey as key,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";

export interface ProfileEditRestore {
  readonly declaration?: JsonObject[string] | undefined;
}
export type ProfileEditCommitReceipt =
  | { readonly kind: "session"; readonly snapshot: SessionProfileSnapshot }
  | { readonly kind: "saved"; readonly document: JsonObject };
interface ProfileEditUndoPlan {
  readonly draft: ProfileRouteDraft;
  readonly restore?: ProfileEditRestore;
}
const restoreKey = ({ declaration }: ProfileEditRestore): string =>
  declaration === undefined ? "absent" : stableJson(declaration);
const rawRestore = (
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  inspection: ProfileSettingsInspection,
): ProfileEditRestore | undefined => {
  if (target.kind === "session") return undefined;
  const document = inspection[`${target.set.scope}Document` as const];
  const sets = document?.profileSets;
  const set = isJsonObject(sets) ? sets[target.set.name] : undefined;
  const profiles = isJsonObject(set) ? set.profiles : undefined;
  const declaration = isJsonObject(profiles) ? profiles[profile] : undefined;
  return { declaration: structuredClone(declaration) };
};

const candidatesKey = (draft: ProfileRouteDraft): string =>
  JSON.stringify(
    Arr.map(draft.candidates, (c) => [
      c.model,
      c.effort,
      c.context,
      c.writeIntent,
      c.openaiFastMode ?? false,
    ]),
  );
const draftKey = (draft: ProfileRouteDraft): string => `${draft.kind}:${candidatesKey(draft)}`;
const copyDraft = (draft: ProfileRouteDraft): ProfileRouteDraft => ({
  kind: draft.kind,
  candidates: cloneProfileCandidates(draft.candidates),
});
const declarationKey = (draft: ProfileRouteDraft): string =>
  draft.kind === "inherit" || draft.kind === "reset" ? "absent" : draftKey(draft);
const baselineKey = (inspection: ProfileSettingsInspection): string => {
  const baseline = inspection.session.baseline;
  const origin = baseline.origin;
  return JSON.stringify([
    origin.scope,
    "name" in origin ? origin.name : undefined,
    "invalid" in origin ? origin.invalid : undefined,
    Arr.map(PROFILE_IDS, (profile) => [
      baseline.profileSources[profile],
      candidatesKey({ kind: "explicit", candidates: baseline.profiles[profile].candidates }),
    ]),
  ]);
};
const targets = (inspection: ProfileSettingsInspection): ProfileWorkspaceTarget[] => [
  { kind: "session" },
  ...Arr.flatMap(["global", "project"] as const, (scope) =>
    Arr.map(Rec.keys(inspection[scope]?.file.profileSets ?? {}), (name) => ({
      kind: "profile-set" as const,
      set: { scope, name },
    })),
  ),
];
const exists = (target: ProfileWorkspaceTarget, inspection: ProfileSettingsInspection): boolean =>
  target.kind === "session" ||
  Rec.has(inspection[target.set.scope]?.file.profileSets ?? {}, target.set.name);

interface RouteState {
  readonly draft: ProfileRouteDraft;
  readonly fingerprint: string;
  readonly restore?: ProfileEditRestore | undefined;
}
const state = (
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  inspection: ProfileSettingsInspection,
): RouteState => {
  const effective = loadProfileRouteDraft(inspection, target, profile);
  const own = hasOwnProfileRouteDeclaration(inspection, target, profile);
  const draft = own
    ? effective
    : {
        kind:
          target.kind === "profile-set" && target.set.scope === "global"
            ? ("reset" as const)
            : ("inherit" as const),
        candidates: effective.candidates,
      };
  const restore = rawRestore(target, profile, inspection);
  return {
    draft: copyDraft(draft),
    restore,
    fingerprint: `${own}:${restore ? restoreKey(restore) : declarationKey(draft)}`,
  };
};
interface Checkpoint {
  readonly opening: ProfileRouteDraft;
  readonly restore?: ProfileEditRestore | undefined;
  readonly openingFingerprint: string;
  observed: string;
  owned: boolean;
  invalidated: boolean;
}

const restorable = (checkpoint: Checkpoint): boolean =>
  checkpoint.opening.kind !== "invalid" &&
  (!checkpoint.restore || captureRestoreDeclaration(checkpoint.restore.declaration) !== undefined);

export class ProfileEditVisit {
  private readonly checkpoints = new Map<string, Map<ProfileId, Checkpoint>>();
  private baseline: string;

  constructor(inspection: ProfileSettingsInspection) {
    this.baseline = baselineKey(inspection);
    for (const target of targets(inspection)) this.captureTarget(target, inspection);
  }

  captureTarget(target: ProfileWorkspaceTarget, inspection: ProfileSettingsInspection): void {
    this.reconcile(inspection);
    if (this.checkpoints.has(key(target)) || !exists(target, inspection)) return;
    this.checkpoints.set(
      key(target),
      new Map(
        Arr.map(PROFILE_IDS, (profile) => {
          const current = state(target, profile, inspection);
          return [
            profile,
            {
              opening: current.draft,
              restore: current.restore,
              openingFingerprint: current.fingerprint,
              observed: current.fingerprint,
              owned: false,
              invalidated: false,
            },
          ];
        }),
      ),
    );
  }

  reconcile(inspection: ProfileSettingsInspection): void {
    if (this.baseline !== baselineKey(inspection)) this.resetSession(inspection);
    const currentTargets = new Map(Arr.map(targets(inspection), (target) => [key(target), target]));
    for (const [id, profiles] of this.checkpoints) {
      const target = currentTargets.get(id);
      if (!target) {
        this.checkpoints.delete(id);
        continue;
      }
      for (const [profile, checkpoint] of profiles) {
        const current = state(target, profile, inspection);
        if (current.fingerprint !== checkpoint.observed) {
          checkpoint.owned = false;
          checkpoint.invalidated = true;
          checkpoint.observed = current.fingerprint;
        }
      }
    }
  }

  isEdited(
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    inspection: ProfileSettingsInspection,
  ): boolean {
    this.reconcile(inspection);
    const checkpoint = this.checkpoints.get(key(target))?.get(profile);
    return (
      checkpoint?.owned === true &&
      !checkpoint.invalidated &&
      restorable(checkpoint) &&
      checkpoint.openingFingerprint !== state(target, profile, inspection).fingerprint
    );
  }

  undoDraft(
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    inspection: ProfileSettingsInspection,
  ): ProfileEditUndoPlan | { error: string } {
    this.reconcile(inspection);
    const checkpoint = this.checkpoints.get(key(target))?.get(profile);
    if (!checkpoint)
      return { error: "This editing target is no longer available. Reopen it before editing." };
    if (checkpoint.invalidated)
      return {
        error: "This profile changed outside this editor. Undo cannot overwrite those changes.",
      };
    if (!restorable(checkpoint))
      return { error: "The opening declaration was invalid and cannot be restored safely." };
    if (!checkpoint.owned) return { error: "There are no changes from this visit to undo." };
    const draft = copyDraft(checkpoint.opening);
    return checkpoint.restore ? { draft, restore: structuredClone(checkpoint.restore) } : { draft };
  }

  recordSave(
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    beforeInspection: ProfileSettingsInspection,
    afterInspection: ProfileSettingsInspection,
    expectedDraft: ProfileRouteDraft,
    receipt?: ProfileEditCommitReceipt,
  ): boolean {
    this.captureTarget(target, beforeInspection);
    const checkpoint = this.checkpoints.get(key(target))?.get(profile);
    const valid = declaredRouteForDraft(expectedDraft).valid;
    let committed = afterInspection;
    if (receipt?.kind === "session" && target.kind === "session") {
      committed = { ...beforeInspection, session: receipt.snapshot };
    } else if (receipt?.kind === "saved" && target.kind === "profile-set") {
      const decoded = subagentConfigDecoder(target.set.scope)(receipt.document);
      committed =
        target.set.scope === "global"
          ? { ...beforeInspection, global: decoded, globalDocument: receipt.document }
          : { ...beforeInspection, project: decoded, projectDocument: receipt.document };
    } else {
      this.reconcile(afterInspection);
      return false;
    }
    const current = state(target, profile, committed);
    if (
      !checkpoint ||
      !valid ||
      !exists(target, committed) ||
      baselineKey(beforeInspection) !== baselineKey(committed) ||
      declarationKey(current.draft) !== declarationKey(expectedDraft)
    ) {
      this.reconcile(afterInspection);
      return false;
    }
    checkpoint.observed = current.fingerprint;
    checkpoint.owned = !checkpoint.invalidated;
    this.reconcile(afterInspection);
    return checkpoint.owned;
  }

  resetSession(inspection: ProfileSettingsInspection): void {
    this.baseline = baselineKey(inspection);
    this.checkpoints.delete("session");
    this.captureTarget({ kind: "session" }, inspection);
  }

  renameTarget(
    previous: ProfileWorkspaceTarget,
    next: ProfileWorkspaceTarget,
    inspection: ProfileSettingsInspection,
  ): void {
    const checkpoint = this.checkpoints.get(key(previous));
    this.checkpoints.delete(key(previous));
    this.checkpoints.delete(key(next));
    if (checkpoint && exists(next, inspection)) this.checkpoints.set(key(next), checkpoint);
    this.captureTarget(next, inspection);
  }

  deleteTarget(target: ProfileWorkspaceTarget): void {
    this.checkpoints.delete(key(target));
  }
}
