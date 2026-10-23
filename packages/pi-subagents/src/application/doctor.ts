import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { SafeFile } from "pi-cosmic-core";
import {
  LOCAL_CLI_LABELS,
  LOCAL_CLI_MINIMUM_VERSIONS,
  type LocalCliVersion,
} from "../backend/local-cli-version.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { hostProfileEnvironment } from "../boundary/host-profile-resolution.ts";
import { nodeExecutableProblem } from "../boundary/node-executable.ts";
import { describeWorktreeHook } from "../boundary/worktree-hook.ts";
import {
  checkoutWorktreeInclude,
  describeWorktreeInclude,
} from "../boundary/git-worktree-include.ts";
import { WORKTREE_HOOK_EVENTS } from "../config/schema.ts";
import {
  gitInstallation,
  gitVersionSupported,
  MINIMUM_GIT_VERSION,
} from "../boundary/git-installation.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import type { ProfileCandidateAttempt, ProfileResolution } from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { InvalidSubagentRequestError } from "../run/errors.ts";

type DoctorStatus = "ok" | "warning" | "failed";

export interface DoctorCheck {
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

interface DoctorInput {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly agentDirectory: string;
  /** Undefined outside the TUI, where the Activity view never registers. */
  readonly activityViewAvailable: boolean | undefined;
  readonly projectTrusted: boolean;
}

const MINIMUM_PI_VERSION = [1, 4, 0] as const;
const PREFLIGHT_TIMEOUT = "20 seconds";

const versionAtLeast = (version: string, minimum: ReadonlyArray<number>): boolean => {
  const parts = Fn.pipe(version, Str.split(/[.-]/u), Arr.map(Number));
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
  Arr.join(
    [attempt.runtime, attempt.model, attempt.effectiveContext, attempt.writeIntent, attempt.effort],
    "|",
  );

const routeLabel = (attempt: ProfileCandidateAttempt): string =>
  `local/${attempt.runtime} · ${attempt.model}`;

const ROUTE_PROBE_CONCURRENCY = 4;

interface RouteCheck {
  readonly label: string;
  readonly plan: ProfileResolution;
  readonly prefix: string;
}

const routeOutcome = (
  { label, plan, prefix }: RouteCheck,
  failures: ReadonlyMap<string, string | undefined>,
): DoctorCheck => {
  if (plan.kind === "failed") return check(label, "failed", plan.message);
  const [first] = plan.attempts;
  if (!first) return check(label, "failed", "no eligible route");
  const failure = failures.get(attemptKey(first));
  const fallbacks = plan.attempts.length - 1;
  return failure === undefined
    ? check(
        label,
        "ok",
        `${prefix}${routeLabel(first)}${fallbacks > 0 ? ` (+${fallbacks} fallback${fallbacks === 1 ? "" : "s"})` : ""}`,
      )
    : check(
        label,
        fallbacks > 0 ? "warning" : "failed",
        `${prefix}${routeLabel(first)}: ${failure}${fallbacks > 0 ? "; a fallback will be tried" : ""}`,
      );
};

/**
 * Checks what a subagent launch depends on, each check independently: Pi's version, saved
 * configuration, the readiness of every profile's first eligible route (including CLI sign-in),
 * private state, and optional companions. It launches nothing. A retired session fails the
 * whole report.
 */
export const runSubagentDoctor = Effect.fn("SubagentDoctor.run")(function* (
  input: DoctorInput,
): Effect.fn.Return<
  ReadonlyArray<DoctorCheck>,
  InvalidSubagentRequestError,
  SubagentProfileService | SubagentBackendRegistry | SafeFile | FileSystem.FileSystem
> {
  const profiles = yield* SubagentProfileService;
  const backends = yield* SubagentBackendRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const nodeProblem = yield* nodeExecutableProblem();
  const checks: DoctorCheck[] = [
    versionAtLeast(VERSION, MINIMUM_PI_VERSION)
      ? check("Pi", "ok", `version ${VERSION}`)
      : check(
          "Pi",
          "failed",
          `version ${VERSION}; subagents need ${Arr.join(Arr.map(MINIMUM_PI_VERSION, String), ".")} or later`,
        ),
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
          `profile set ${setName}; invalid fields (ignored, clamped, or failed closed): ${Arr.join(config.diagnostics, ", ")}`,
        ),
    input.projectTrusted
      ? check("Project settings", "ok", "trusted; project configuration applies")
      : check(
          "Project settings",
          "warning",
          "project is not trusted; its configuration is ignored",
        ),
  );

  const environment = yield* hostProfileEnvironment(input.pi, input.ctx);
  const routes: ReadonlyArray<RouteCheck> = [
    ...Arr.map(PROFILE_IDS, (id) => ({
      label: `Profile ${id}`,
      plan: profiles.resolve(snapshot, id, environment),
      prefix: "",
    })),
    ...Arr.map(config.agents, (agent) => ({
      label: `Agent ${agent.name}`,
      plan: profiles.resolve(snapshot, agent.profile, environment, agent),
      prefix: `${agent.source} · profile ${agent.profile} · `,
    })),
  ];
  // Profiles often share a route; each distinct first route is probed once.
  const probes = new Map<string, ProfileCandidateAttempt>();
  const cliRuntimes = new Set<LocalCliRuntime>();
  for (const { plan } of routes) {
    if (plan.kind === "failed") continue;
    for (const attempt of plan.attempts)
      if (attempt.runtime !== "pi") cliRuntimes.add(attempt.runtime);
    const [first] = plan.attempts;
    if (first && !probes.has(attemptKey(first))) probes.set(attemptKey(first), first);
  }
  const failures = new Map(
    yield* Effect.forEach(
      probes,
      ([key, attempt]) =>
        readinessFailure(backends, attempt, input.ctx.cwd).pipe(
          Effect.map((failure) => [key, failure] as const),
        ),
      { concurrency: ROUTE_PROBE_CONCURRENCY },
    ),
  );
  checks.push(...Arr.map(routes, (route) => routeOutcome(route, failures)));
  for (const invalid of config.invalidAgents)
    checks.push(
      invalid.name === undefined
        ? check(
            `Agents (${invalid.scope})`,
            "failed",
            `the ${invalid.scope} agents object is invalid, so every agent it could declare fails closed`,
          )
        : check(
            `Agent ${invalid.name}`,
            "failed",
            `invalid ${invalid.scope} entry; it fails closed until repaired`,
          ),
    );

  for (const runtime of cliRuntimes) {
    const version = yield* cliVersionCheck(backends, runtime);
    if (version) checks.push(version);
  }

  const writable = yield* fileSystem.access(input.agentDirectory, { writable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  checks.push(
    writable
      ? check("Private state", "ok", input.agentDirectory)
      : check("Private state", "failed", `${input.agentDirectory} is not writable`),
  );
  for (const event of WORKTREE_HOOK_EVENTS) {
    const hooks = config.hooks[event];
    const invalid = event === "WorktreeCreate" ? config.hooks.invalidWorktreeCreate : [];
    checks.push(
      invalid.length > 0
        ? check(
            `${event} hooks`,
            "failed",
            `invalid declarations (${Arr.join(invalid, ", ")}); worktree setup fails until they are fixed`,
          )
        : check(
            `${event} hooks`,
            "ok",
            hooks.length === 0
              ? "none"
              : Fn.pipe(
                  hooks,
                  Arr.map((hook) => `${hook.scope}: ${describeWorktreeHook(hook)}`),
                  Arr.join("; "),
                ),
          ),
    );
  }
  checks.push(yield* worktreeIncludeCheck(input.ctx.cwd));
  checks.push(yield* gitCheck);
  if (input.activityViewAvailable !== undefined)
    checks.push(
      input.activityViewAvailable
        ? check("Activity view", "ok", "shared Activity manager available")
        : check("Activity view", "warning", "install pi-cosmic-ui for the shared Activity view"),
    );
  return checks;
});

// Creation reads the same file, so a file it would refuse warns here.
const worktreeIncludeCheck = (cwd: string): Effect.Effect<DoctorCheck, never, SafeFile> =>
  checkoutWorktreeInclude(cwd).pipe(
    Effect.map((patterns) =>
      patterns === undefined || patterns.length === 0
        ? check(".worktreeinclude", "ok", "none; isolated trees get no ignored or credential files")
        : check(".worktreeinclude", "ok", describeWorktreeInclude(patterns)),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        check(
          ".worktreeinclude",
          "warning",
          Arr.join(
            [error.message, ...(error.detail === undefined ? [] : Str.split(error.detail, "\n"))],
            " ",
          ),
        ),
      ),
    ),
  );

// Isolated (worktree) writers need Git; shared-checkout writers don't, so problems are warnings.
const gitCheck: Effect.Effect<DoctorCheck> = gitInstallation.pipe(
  Effect.map((installation) =>
    gitVersionSupported(installation.version)
      ? check("Git", "ok", `${installation.version} at ${installation.executable}`)
      : check(
          "Git",
          "warning",
          `${installation.version} at ${installation.executable}; isolated writers need ${Arr.join(Arr.map(MINIMUM_GIT_VERSION, String), ".")} or later`,
        ),
  ),
  Effect.catch((error) =>
    Effect.succeed(
      check(
        "Git",
        "warning",
        Arr.join(
          [error.message, ...(error.detail === undefined ? [] : Str.split(error.detail, "\n"))],
          " ",
        ),
      ),
    ),
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
      { runtime: attempt.runtime, context: attempt.effectiveContext },
      {
        context: attempt.effectiveContext,
        writeIntent: attempt.writeIntent,
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
  return Fn.absurd(version);
};

// The version a launch's preflight checks, cached for the session by the CLI boundary.
const cliVersionCheck = (
  backends: SubagentBackendRegistry["Service"],
  runtime: LocalCliRuntime,
): Effect.Effect<DoctorCheck | undefined> =>
  backends.resolve({ runtime, context: "fresh" }).pipe(
    Effect.flatMap((driver) => driver.cliVersion ?? Effect.undefined),
    Effect.map((version) => version && versionCheck(runtime, version)),
    Effect.orElseSucceed(() => undefined),
  );

const STATUS_GLYPHS = { ok: "✓", warning: "!", failed: "✗" } as const;

export const formatDoctorReport = (checks: ReadonlyArray<DoctorCheck>): string =>
  Arr.join(
    [
      "Subagents doctor",
      ...Arr.map(checks, (item) => `${STATUS_GLYPHS[item.status]} ${item.label}: ${item.detail}`),
    ],
    "\n",
  );
