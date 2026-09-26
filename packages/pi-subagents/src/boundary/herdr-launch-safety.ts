import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { hasAvailableHerdrShell } from "../backend/herdr-shell-readiness.ts";
import { exactPaneContext } from "../backend/herdr-ownership.ts";
import { processError, SubagentProcessError } from "../run/errors.ts";
import type { HerdrCliContract, HerdrPane, HerdrSnapshot } from "./herdr-cli.ts";
import type { HerdrPreparedHarness } from "./herdr-harness.ts";

const SHELL_READINESS_ATTEMPTS = 51;
const SHELL_READINESS_DELAY_MILLIS = 200;
const PANE_INPUT_ACTIVATION_ATTEMPTS = 2;

const provisionalOwnershipMismatch = (operation: string, message: string) =>
  processError(operation, "herdr_provisional_ownership_mismatch", message);

export interface HerdrLaunchSafety {
  readonly inspectProvisionalPane: (
    pane: HerdrPane,
    operation: string,
    invalidate: () => void,
  ) => Effect.Effect<
    { readonly snapshot: HerdrSnapshot; readonly occupied: boolean },
    SubagentProcessError
  >;
  readonly requireAvailableProvisionalPane: (
    pane: HerdrPane,
    operation: string,
    invalidate: () => void,
    agentName?: string,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly waitForAvailableShell: (
    pane: HerdrPane,
    invalidate: () => void,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly activatePaneInput: (
    pane: HerdrPane,
    harness: HerdrPreparedHarness,
    invalidate: () => void,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly confirmShellInput: (
    pane: HerdrPane,
    harness: HerdrPreparedHarness,
    phase: "environment" | "secrets",
    invalidate: () => void,
  ) => Effect.Effect<void, SubagentProcessError>;
}

/** I/O safety gate for focus-neutral provisional pane mutation. */
export const makeHerdrLaunchSafety = (cli: HerdrCliContract): HerdrLaunchSafety => {
  const inspectProvisionalPane: HerdrLaunchSafety["inspectProvisionalPane"] = (
    pane,
    operation,
    invalidate,
  ) =>
    cli.snapshot.pipe(
      Effect.flatMap((snapshot) => {
        if (!exactPaneContext(pane, snapshot)) {
          invalidate();
          return Effect.fail(
            provisionalOwnershipMismatch(
              operation,
              "The provisional Herdr workspace/tab/pane/terminal ownership tuple changed; no pane input was allowed.",
            ),
          );
        }
        const occupants = snapshot.agents.filter(
          (agent) => agent.paneId === pane.paneId || agent.terminalId === pane.terminalId,
        );
        if (
          occupants.some(
            (agent) =>
              agent.paneId !== pane.paneId ||
              agent.terminalId !== pane.terminalId ||
              agent.workspaceId !== pane.workspaceId ||
              agent.tabId !== pane.tabId,
          )
        ) {
          invalidate();
          return Effect.fail(
            provisionalOwnershipMismatch(
              operation,
              "A mismatched agent occupied the provisional Herdr pane; no pane input was allowed.",
            ),
          );
        }
        return Effect.succeed({ snapshot, occupied: occupants.length > 0 });
      }),
    );

  const requireAvailableProvisionalPane: HerdrLaunchSafety["requireAvailableProvisionalPane"] = (
    pane,
    operation,
    invalidate,
    agentName,
  ) =>
    inspectProvisionalPane(pane, operation, invalidate).pipe(
      Effect.flatMap(({ snapshot, occupied }) => {
        if (agentName && snapshot.agents.some((agent) => agent.name === agentName))
          return Effect.fail(
            processError(
              operation,
              "herdr_agent_name_unavailable",
              "The generated Herdr agent name is already present; agent start was refused.",
            ),
          );
        if (occupied)
          return Effect.fail(
            processError(
              operation,
              "herdr_pane_shell_not_ready",
              "The exact provisional Herdr pane became occupied; no pane input was allowed.",
            ),
          );
        return Effect.void;
      }),
    );

  const waitForAvailableShell: HerdrLaunchSafety["waitForAvailableShell"] = (pane, invalidate) =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= SHELL_READINESS_ATTEMPTS; attempt += 1) {
        yield* inspectProvisionalPane(pane, "inspect pane shell", invalidate);
        const processInfo = yield* cli.paneProcessInfo(pane.paneId);
        if (processInfo.paneId !== pane.paneId) {
          invalidate();
          return yield* provisionalOwnershipMismatch(
            "inspect pane shell",
            "Herdr returned process information for a different owned pane.",
          );
        }
        const after = yield* inspectProvisionalPane(pane, "inspect pane shell", invalidate);
        if (hasAvailableHerdrShell(processInfo) && !after.occupied) return;
        if (attempt < SHELL_READINESS_ATTEMPTS)
          yield* Effect.sleep(Duration.millis(SHELL_READINESS_DELAY_MILLIS));
      }
      return yield* processError(
        "inspect pane shell",
        "herdr_pane_shell_not_ready",
        "The exact owned Herdr pane did not reach an available, unoccupied interactive shell before protected input or agent start.",
      );
    });

  const activatePaneInput: HerdrLaunchSafety["activatePaneInput"] = (pane, harness, invalidate) =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= PANE_INPUT_ACTIVATION_ATTEMPTS; attempt += 1) {
        yield* requireAvailableProvisionalPane(pane, "activate pane input", invalidate);
        const receipt = harness.startupAttestation.activationReceipt(attempt === 1 ? 1 : 2);
        yield* cli.runPaneCommand(pane.paneId, receipt.command, "activate pane input");
        const confirmed = yield* receipt.observe.pipe(
          Effect.as(true),
          Effect.catch((error) =>
            error.code === "herdr_startup_receipt_timeout"
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        );
        if (confirmed) {
          yield* inspectProvisionalPane(pane, "confirm pane input", invalidate);
          return;
        }
        if (attempt < PANE_INPUT_ACTIVATION_ATTEMPTS) {
          // Herdr 0.8 can drop a focus-free pane-run after session restore. Before the one
          // harmless retry, revalidate exact ownership and bracket a fresh foreground-shell
          // inspection with snapshots. Never focus the target tab to improve reliability.
          yield* waitForAvailableShell(pane, invalidate);
        }
      }
      return yield* processError(
        "activate pane input",
        "herdr_pane_input_unavailable",
        "Neither harmless activation attempt published its private receipt in the owned pane. No environment, secret, or agent launch command was attempted.",
      );
    });

  const confirmShellInput: HerdrLaunchSafety["confirmShellInput"] = (
    pane,
    harness,
    phase,
    invalidate,
  ) =>
    Effect.gen(function* () {
      yield* requireAvailableProvisionalPane(pane, "confirm pane shell", invalidate);
      const receipt =
        phase === "environment"
          ? harness.startupAttestation.postEnvironmentShellReceipt
          : harness.startupAttestation.postSecretShellReceipt;
      yield* cli.runPaneCommand(pane.paneId, receipt.command, "confirm pane shell");
      yield* receipt.observe;
      yield* inspectProvisionalPane(pane, "confirm pane shell", invalidate);
    });

  return {
    inspectProvisionalPane,
    requireAvailableProvisionalPane,
    waitForAvailableShell,
    activatePaneInput,
    confirmShellInput,
  };
};
