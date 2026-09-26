import type { JsonObject } from "pi-cosmic-core";
import {
  mapProfileIds,
  type ProfileCandidate,
  type ProfileRouteSource,
} from "../../src/profiles/model.ts";
import type { SessionProfileBaseline } from "../../src/profiles/session-overrides.ts";

/** A normalized local Pi candidate; overrides replace any field. */
export const profileCandidate = (
  model = "parent",
  overrides: Partial<ProfileCandidate> = {},
): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  closeOnReport: true,
  ...overrides,
});

/** A raw persisted candidate without openaiFastMode, so it stays valid in every config version. */
export const declaredCandidate = (model: string, overrides: JsonObject = {}): JsonObject => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  closeOnReport: true,
  ...overrides,
});

/** A complete seven-profile baseline of saved set "saved" whose reviewer comes from that set. */
export const completeBaseline = (
  scope: "global" | "project",
  reviewerModel = "parent",
  siblingSource: ProfileRouteSource = scope,
): SessionProfileBaseline => ({
  origin: { scope, name: "saved" },
  profiles: mapProfileIds((id) => ({
    candidates: [profileCandidate(id === "reviewer" ? reviewerModel : "parent")],
  })),
  profileSources: mapProfileIds((id) => (id === "reviewer" ? scope : siblingSource)),
});
