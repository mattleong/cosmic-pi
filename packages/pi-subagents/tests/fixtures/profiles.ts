import type { JsonObject } from "pi-cosmic-core";
import {
  mapProfileIds,
  type ProfileCandidate,
  type ProfileRouteSource,
} from "../../src/profiles/model.ts";
import type { SessionProfileBaseline } from "../../src/profiles/session-overrides.ts";

export const profileCandidate = (
  model = "parent",
  overrides: Partial<ProfileCandidate> = {},
): ProfileCandidate => ({
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  ...overrides,
});

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
