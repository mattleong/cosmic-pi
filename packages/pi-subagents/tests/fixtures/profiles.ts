import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import type { JsonObject } from "pi-cosmic-core";
import type { ResolvedSubagentConfig } from "../../src/config/options.ts";
import {
  mapProfileIds,
  type ProfileCandidate,
  type ProfileRouteSource,
} from "../../src/profiles/model.ts";
import {
  SubagentProfileService,
  subagentProfileServiceLayerFor,
} from "../../src/profiles/service.ts";
import type { SessionProfileBaseline } from "../../src/profiles/session-overrides.ts";

export const profileCandidate = (
  model = "parent",
  overrides: Partial<ProfileCandidate> = {},
): ProfileCandidate => ({
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  ...overrides,
});

export const declaredCandidate = (model: string, overrides: JsonObject = {}): JsonObject => ({
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
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

/** The profile service its layer builds from an already resolved configuration. */
export const builtProfileService = (
  config: ResolvedSubagentConfig,
  options: Parameters<typeof subagentProfileServiceLayerFor>[1] = {},
) =>
  SubagentProfileService.use(Effect.succeed).pipe(
    Effect.provide(subagentProfileServiceLayerFor(config, options)),
    Effect.orDie,
  );

/** The global slot a reload hands session profile settings through. */
export const profileReloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

export const profileReloadSlotPresent = () =>
  Rec.has<string | symbol, unknown>(globalThis, profileReloadSlot);

export const writeProfileReloadSlot = (descriptor: PropertyDescriptor) =>
  Object.defineProperty(globalThis, profileReloadSlot, {
    configurable: true,
    enumerable: true,
    writable: true,
    ...descriptor,
  });
