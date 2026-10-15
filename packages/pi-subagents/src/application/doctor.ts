import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import {
  LOCAL_CLI_LABELS,
  LOCAL_CLI_MINIMUM_VERSIONS,
  type LocalCliVersion,
} from "../backend/local-cli-version.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { hostProfileEnvironment } from "../boundary/host-profile-resolution.ts";
import { nodeFsConstants, nodeFsPromises as fs } from "../boundary/node-builtins.ts";
import { nodeExecutableProblem } from "../boundary/node-executable.ts";
import { describeWorkspaceSetup } from "../boundary/workspace-setup.ts";
import {
  gitInstallation,
  gitVersionSupported,
  MINIMUM_GIT_VERSION,
} from "../boundary/git-installation.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import type { ProfileCandidateAttempt } from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";

export type DoctorStatus = "ok" | "warning" | "failed";

export interface DoctorCheck {
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorInput {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly agentDirectory: string;
  /** Undefined outside the TUI, where the Activity view never registers. */
  readonly activityViewAvailable: boolean | undefined;
  readonly projectTrusted: boolean;
}

const MINIMUM_PI_VERSION = [1, 2, 0] as const;
const PREFLIGHT_TIMEOUT = "20 seconds";

const versionAtLeast = (version: string, minimum: ReadonlyArray<number>): boolean => {
  const parts = version.split(/[.-]/u).map(Number);
  for (const [index, required] of minimum.entries()) {
    const actual = parts[index] ?? 0;
    if (Number.isNaN(actual)) return false;
    if (actual !== required) return actual > required;
  }
  return true;
};

const check = (label: string, status: DoctorStatus, detail: string): DoctorCheck => ({
  label,
  status,
  detail,
});

const attemptKey = (attempt: ProfileCandidateAttempt): string =>
  [
    attempt.host,
    attempt.runtime,
    attempt.model,
    attempt.effectiveContext,
    attempt.writeIntent,
    attempt.effort,
  ].join("|");

const routeLabel = (attempt: ProfileCandidateAttempt): string =>
  `${attempt.host}/${attempt.runtime} · ${attempt.model}`;

/**
 * Checks what a subagent launch depends on, each check independently: Pi's version, saved
 * configuration, the readiness of every profile's first eligible route (including CLI sign-in),
 * private state, and optional companions. It launches nothing.
 */
export const runSubagentDoctor = (
  input: DoctorInput,
): Effect.Effect<
  ReadonlyArray<DoctorCheck>,
  never,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const backends = yield* SubagentBackendRegistry;
    const nodeProblem = yield* nodeExecutableProblem();
    const checks: DoctorCheck[] = [
      versionAtLeast(VERSION, MINIMUM_PI_VERSION)
        ? check("Pi", "ok", `version ${VERSION}`)
        : check("Pi", "failed", `version ${VERSION}; subagents need 1.2.0 or later`),
      nodeProblem ? check("Node", "failed", nodeProblem) : check("Node", "ok", process.execPath),
    ];

    const snapshot = yield* profiles.capture;
    const config = snapshot.effectiveConfig;
    const setName =
      config.currentProfileSet.scope === "builtin"
        ? "built-in routes"
        : `${config.currentProfileSet.name ?? "unnamed"} (${config.currentProfileSet.scope})`;
    checks.push(
      config.diagnostics.length === 0
        ? check("Configuration", "ok", `profile set ${setName}`)
        : check(
            "Configuration",
            "warning",
            `profile set ${setName}; ignored fields: ${config.diagnostics.join(", ")}`,
          ),
      input.projectTrusted
        ? check("Project settings", "ok", "trusted; project configuration applies")
        : check(
            "Project settings",
            "warning",
            "project is not trusted; its configuration is ignored",
          ),
    );

    const environment = hostProfileEnvironment(input.pi, input.ctx);
    // Profiles often share a route; each distinct route is probed once.
    const outcomes = new Map<string, string | undefined>();
    const cliRuntimes = new Set<LocalCliRuntime>();
    for (const id of PROFILE_IDS) {
      const plan = profiles.resolve(snapshot, id, environment);
      if (plan.kind === "failed") {
        checks.push(check(`Profile ${id}`, "failed", plan.message));
        continue;
      }
      for (const attempt of plan.attempts)
        if (attempt.host === "local" && attempt.runtime !== "pi") cliRuntimes.add(attempt.runtime);
      const [first] = plan.attempts;
      if (!first) {
        checks.push(check(`Profile ${id}`, "failed", "no eligible route"));
        continue;
      }
      const key = attemptKey(first);
      const failure = outcomes.has(key)
        ? outcomes.get(key)
        : yield* readinessFailure(backends, first, input.ctx.cwd);
      outcomes.set(key, failure);
      const fallbacks = plan.attempts.length - 1;
      checks.push(
        failure === undefined
          ? check(
              `Profile ${id}`,
              "ok",
              `${routeLabel(first)}${fallbacks > 0 ? ` (+${fallbacks} fallback${fallbacks === 1 ? "" : "s"})` : ""}`,
            )
          : check(
              `Profile ${id}`,
              fallbacks > 0 ? "warning" : "failed",
              `${routeLabel(first)}: ${failure}${fallbacks > 0 ? "; a fallback will be tried" : ""}`,
            ),
      );
    }

    for (const runtime of cliRuntimes) {
      const version = yield* cliVersionCheck(backends, runtime);
      if (version) checks.push(version);
    }

    const writable = yield* Effect.promise(() =>
      fs.access(input.agentDirectory, nodeFsConstants.W_OK).then(
        () => true,
        () => false,
      ),
    );
    checks.push(
      writable
        ? check("Private state", "ok", input.agentDirectory)
        : check("Private state", "failed", `${input.agentDirectory} is not writable`),
      config.workspaceSetup
        ? check("Worktree setup", "ok", describeWorkspaceSetup(config.workspaceSetup))
        : check("Worktree setup", "ok", "none; isolated writers start without dependencies"),
    );
    checks.push(yield* gitCheck);
    if (input.activityViewAvailable !== undefined)
      checks.push(
        input.activityViewAvailable
          ? check("Activity view", "ok", "shared Activity manager available")
          : check("Activity view", "warning", "install pi-cosmic-ui for the shared Activity view"),
      );
    return checks;
  });

// Isolated (worktree) writers need Git; shared-checkout writers don't, so problems are warnings.
const gitCheck: Effect.Effect<DoctorCheck> = gitInstallation.pipe(
  Effect.map((installation) =>
    gitVersionSupported(installation.version)
      ? check("Git", "ok", `${installation.version} at ${installation.executable}`)
      : check(
          "Git",
          "warning",
          `${installation.version} at ${installation.executable}; isolated writers need ${MINIMUM_GIT_VERSION.join(".")} or later`,
        ),
  ),
  Effect.catch((error) =>
    Effect.succeed(check("Git", "warning", `${error.message} ${error.detail ?? ""}`.trim())),
  ),
);

// Readiness runs the same preflight a launch does, bounded so a hung CLI can't stall the report.
const readinessFailure = (
  backends: SubagentBackendRegistry["Service"],
  attempt: ProfileCandidateAttempt,
  cwd: string,
): Effect.Effect<string | undefined> =>
  backends
    .preflight(
      { host: attempt.host, runtime: attempt.runtime, context: attempt.effectiveContext },
      {
        context: attempt.effectiveContext,
        writeIntent: attempt.writeIntent,
        closeOnReport: attempt.closeOnReport,
        model: attempt.model,
        effort: attempt.effort,
        cwd,
      },
    )
    .pipe(
      Effect.as(undefined),
      Effect.catch((error) =>
        Effect.succeed(error.code ? `${error.message} [${error.code}]` : error.message),
      ),
      Effect.timeoutOption(PREFLIGHT_TIMEOUT),
      Effect.map(Option.getOrElse(() => "readiness check timed out")),
    );

type LocalCliRuntime = keyof typeof LOCAL_CLI_LABELS;

const versionCheck = (runtime: LocalCliRuntime, version: LocalCliVersion): DoctorCheck => {
  const label = `${LOCAL_CLI_LABELS[runtime]} CLI`;
  const minimum = LOCAL_CLI_MINIMUM_VERSIONS[runtime];
  switch (version.status) {
    case "supported":
      return check(label, "ok", `version ${version.version}`);
    case "unsupported":
      return check(
        label,
        "failed",
        `version ${version.version}; subagents need ${minimum} or later, so its routes are skipped`,
      );
    case "unrecognized":
      return check(
        label,
        "warning",
        `version output "${version.output}" isn't recognized; can't confirm ${minimum} or later`,
      );
    case "unavailable":
      return check(label, "warning", "not found, or it didn't report a version");
  }
  return absurd(version);
};

// The version a launch's preflight checks, cached for the session by the CLI boundary.
const cliVersionCheck = (
  backends: SubagentBackendRegistry["Service"],
  runtime: LocalCliRuntime,
): Effect.Effect<DoctorCheck | undefined> =>
  backends.resolve({ host: "local", runtime, context: "fresh" }).pipe(
    Effect.flatMap((driver) => driver.cliVersion ?? Effect.succeed(undefined)),
    Effect.map((version) => version && versionCheck(runtime, version)),
    Effect.orElseSucceed(() => undefined),
  );

const STATUS_GLYPHS = { ok: "✓", warning: "!", failed: "✗" } as const;

export const formatDoctorReport = (checks: ReadonlyArray<DoctorCheck>): string =>
  [
    "Subagents doctor",
    ...checks.map((item) => `${STATUS_GLYPHS[item.status]} ${item.label}: ${item.detail}`),
  ].join("\n");
