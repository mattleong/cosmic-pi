import { isJsonObject, type JsonObject } from "pi-cosmic-core";
import { decodeSubagentConfig } from "../config/schema.ts";
import { captureRestoreDeclaration } from "../config/profile-restore.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import { PROFILE_IDS, cloneProfileCandidates, type ProfileId } from "../profiles/model.ts";
import {
  declaredRouteForDraft,
  hasOwnProfileRouteDeclaration,
  loadProfileRouteDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";

export interface ProfileEditRestore {
  readonly sourceVersion: number;
  readonly declaration?: JsonObject[string] | undefined;
}
export type ProfileEditCommitReceipt =
  | { readonly kind: "session"; readonly snapshot: SessionProfileSnapshot }
  | { readonly kind: "saved"; readonly document: JsonObject };
export interface ProfileEditUndoPlan {
  readonly draft: ProfileRouteDraft;
  readonly restore?: ProfileEditRestore;
}
const canonical = (value: JsonObject[string] | undefined): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "absent";
};
// Match store migration for comparison only; retain the raw checkpoint for exact restore.
const restoreKey = (restore: ProfileEditRestore): string => {
  const declaration = restore.declaration;
  if (restore.sourceVersion !== 4 && restore.sourceVersion !== 5) return canonical(declaration);
  const migrateCandidate = (value: JsonObject[string]): JsonObject[string] => {
    if (!isJsonObject(value)) return value;
    const next: JsonObject = {};
    for (const [field, entry] of Object.entries(value)) {
      if (field !== "fastMode") next[field] = entry;
    }
    if (value.fastMode === true) next.openaiFastMode = true;
    return next;
  };
  return canonical(
    Array.isArray(declaration)
      ? declaration.map(migrateCandidate)
      : declaration === undefined
        ? undefined
        : migrateCandidate(declaration),
  );
};
const rawRestore = (
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  inspection: ProfileSettingsInspection,
): ProfileEditRestore | undefined => {
  if (target.kind === "session") return undefined;
  const document =
    target.set.scope === "global" ? inspection.globalDocument : inspection.projectDocument;
  const sets = document?.profileSets;
  const set = isJsonObject(sets) ? sets[target.set.name] : undefined;
  const legacy = document?.version === 4 || document?.version === 5;
  const profiles =
    legacy && target.set.name === "default"
      ? document.profiles
      : isJsonObject(set)
        ? set.profiles
        : undefined;
  const declaration = isJsonObject(profiles) ? profiles[profile] : undefined;
  return {
    sourceVersion: inspection[target.set.scope]?.file.version ?? 6,
    declaration: structuredClone(declaration),
  };
};
const key = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session" ? "session" : `${target.set.scope}/${target.set.name}`;

// Fixed tuples compare domain values, not object insertion order or document formatting.
const candidatesKey = (draft: ProfileRouteDraft): string =>
  JSON.stringify(
    draft.candidates.map((c) => [
      c.host,
      c.runtime,
      c.model,
      c.effort,
      c.context,
      c.writeIntent,
      c.openaiFastMode ?? false,
      c.closeOnReport,
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
    PROFILE_IDS.map((profile) => [
      baseline.profileSources[profile],
      candidatesKey({ kind: "explicit", candidates: baseline.profiles[profile].candidates }),
    ]),
  ]);
};
const targets = (inspection: ProfileSettingsInspection): ProfileWorkspaceTarget[] => [
  { kind: "session" },
  ...(["global", "project"] as const).flatMap((scope) =>
    Object.keys(inspection[scope]?.file.profileSets ?? {}).map((name) => ({
      kind: "profile-set" as const,
      set: { scope, name },
    })),
  ),
];
const exists = (target: ProfileWorkspaceTarget, inspection: ProfileSettingsInspection): boolean =>
  target.kind === "session" ||
  Object.hasOwn(inspection[target.set.scope]?.file.profileSets ?? {}, target.set.name);

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
  (!checkpoint.restore ||
    captureRestoreDeclaration(checkpoint.restore.declaration, checkpoint.restore.sourceVersion) !==
      undefined);

/** Synchronous bookkeeping for one dashboard visit. It owns no runtime or persistence. */
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
        PROFILE_IDS.map((profile) => {
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
    const currentTargets = new Map(targets(inspection).map((target) => [key(target), target]));
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
      !!checkpoint?.owned &&
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

  /** Call only after a successful save, before reconciling its returned inspection. */
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
      const decoded = decodeSubagentConfig(receipt.document, target.set.scope);
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

  /** Call before reconcile after an owned rename. External renames must not transfer authority. */
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
