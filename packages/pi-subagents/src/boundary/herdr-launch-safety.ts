import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { hasAvailableHerdrShell } from "../backend/herdr-shell-readiness.ts";
import { matchingPaneIdentity } from "../backend/herdr-ownership.ts";
import { processError, SubagentProcessError } from "../run/errors.ts";
import type { HerdrCliContract, HerdrPane, HerdrSnapshot } from "./herdr-cli.ts";
import type { HerdrPreparedHarness } from "./herdr-harness.ts";

const SHELL_READINESS_ATTEMPTS = 51;
const SHELL_READINESS_DELAY_MILLIS = 200;
const PANE_INPUT_ACTIVATION_ATTEMPTS = 2;

const ownershipMismatch = (operation: string, message: string) =>
  processError(operation, "herdr_ownership_mismatch", message);
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
    requireFocused: boolean,
    invalidate: () => void,
    agentName?: string,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly waitForAvailableShell: (
    pane: HerdrPane,
    invalidate: () => void,
    requireFocused?: boolean,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly activatePaneInput: (
    before: HerdrSnapshot,
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
  readonly restoreFocus: (
    before: HerdrSnapshot,
    ownedTabId: string,
    validateBeforeMutation?: (snapshot: HerdrSnapshot) => Effect.Effect<void, SubagentProcessError>,
  ) => Effect.Effect<void, SubagentProcessError>;
}

/** I/O safety gate for provisional pane mutation and non-stealing focus restoration. */
export const makeHerdrLaunchSafety = (
  cli: HerdrCliContract,
  exactPaneContext: (pane: HerdrPane, snapshot: HerdrSnapshot) => boolean,
): HerdrLaunchSafety => {
  const inspectProvisionalPane: HerdrLaunchSafety["inspectProvisionalPane"] = (
    pane,
    operation,
    invalidate,
  ) =>
    cli.snapshot.pipe(
      Effect.flatMap((snapshot) => {
        const exactPane = matchingPaneIdentity(pane, snapshot);
        if (!exactPaneContext(pane, snapshot) || !exactPane) {
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
    requireFocused,
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
        if (
          requireFocused &&
          (snapshot.focusedTabId !== pane.tabId ||
            (snapshot.focusedWorkspaceId !== undefined &&
              snapshot.focusedWorkspaceId !== pane.workspaceId))
        )
          return Effect.fail(
            ownershipMismatch(
              operation,
              "The provisional Herdr tab no longer held focus; no pane input was allowed.",
            ),
          );
        return Effect.void;
      }),
    );

  const waitForAvailableShell: HerdrLaunchSafety["waitForAvailableShell"] = (
    pane,
    invalidate,
    requireFocused = false,
  ) =>
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
        const focusMatches =
          !requireFocused ||
          (after.snapshot.focusedTabId === pane.tabId &&
            (after.snapshot.focusedWorkspaceId === undefined ||
              after.snapshot.focusedWorkspaceId === pane.workspaceId));
        if (hasAvailableHerdrShell(processInfo) && !after.occupied && focusMatches) return;
        if (attempt < SHELL_READINESS_ATTEMPTS)
          yield* Effect.sleep(Duration.millis(SHELL_READINESS_DELAY_MILLIS));
      }
      return yield* processError(
        "inspect pane shell",
        "herdr_pane_shell_not_ready",
        "The exact owned Herdr pane did not reach an available, unoccupied interactive shell before protected input or agent start.",
      );
    });

  const activatePaneInput: HerdrLaunchSafety["activatePaneInput"] = (
    before,
    pane,
    harness,
    invalidate,
  ) =>
    Effect.gen(function* () {
      const previousTabId = before.focusedTabId;
      const previousTabs = before.tabs.filter((tab) => tab.tabId === previousTabId);
      const previousTab = previousTabs.length === 1 ? previousTabs[0] : undefined;
      for (let attempt = 1; attempt <= PANE_INPUT_ACTIVATION_ATTEMPTS; attempt += 1) {
        const beforeFocus = yield* inspectProvisionalPane(pane, "activate pane input", invalidate);
        const currentPreviousTabs = beforeFocus.snapshot.tabs.filter(
          (tab) => tab.tabId === previousTabId,
        );
        const currentPrevious = currentPreviousTabs[0];
        const previousFocusMatches =
          attempt === 1 &&
          previousTab !== undefined &&
          currentPreviousTabs.length === 1 &&
          beforeFocus.snapshot.focusedTabId === previousTabId &&
          currentPrevious?.workspaceId === previousTab.workspaceId &&
          currentPrevious.label === previousTab.label &&
          (beforeFocus.snapshot.focusedWorkspaceId === undefined ||
            beforeFocus.snapshot.focusedWorkspaceId === previousTab.workspaceId);
        const focusCanBeChanged =
          beforeFocus.snapshot.focusedTabId === pane.tabId || previousFocusMatches;
        if (beforeFocus.occupied || !focusCanBeChanged)
          return yield* processError(
            "activate pane input",
            "herdr_focus_changed",
            "The provisional Herdr pane became occupied or user focus moved; activation input was refused.",
          );
        yield* cli.focusTab(pane.tabId, "activate herdr tab");
        yield* requireAvailableProvisionalPane(pane, "activate pane input", true, invalidate);
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
          // A first accepted pane-run can be dropped by a restored workspace. Before the one
          // harmless retry, revalidate exact ownership and current focus, explicitly refocus the
          // same tab, and bracket a fresh foreground-shell inspection with snapshots.
          const retry = yield* inspectProvisionalPane(pane, "retry pane activation", invalidate);
          if (
            retry.occupied ||
            retry.snapshot.focusedTabId !== pane.tabId ||
            (retry.snapshot.focusedWorkspaceId !== undefined &&
              retry.snapshot.focusedWorkspaceId !== pane.workspaceId)
          )
            return yield* processError(
              "activate pane input",
              "herdr_focus_changed",
              "The provisional Herdr pane became occupied or user focus moved; activation input was refused.",
            );
          yield* cli.focusTab(pane.tabId, "activate herdr tab");
          yield* waitForAvailableShell(pane, invalidate, true);
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
      yield* requireAvailableProvisionalPane(pane, "confirm pane shell", true, invalidate);
      const receipt =
        phase === "environment"
          ? harness.startupAttestation.postEnvironmentShellReceipt
          : harness.startupAttestation.postSecretShellReceipt;
      yield* cli.runPaneCommand(pane.paneId, receipt.command, "confirm pane shell");
      yield* receipt.observe;
      yield* inspectProvisionalPane(pane, "confirm pane shell", invalidate);
    });

  const restoreFocus: HerdrLaunchSafety["restoreFocus"] = (
    before,
    ownedTabId,
    validateBeforeMutation,
  ) => {
    const previousTabId = before.focusedTabId;
    const previousTabsBefore = before.tabs.filter((tab) => tab.tabId === previousTabId);
    const previousTab = previousTabsBefore.length === 1 ? previousTabsBefore[0] : undefined;
    return cli.snapshot.pipe(
      Effect.flatMap((after) =>
        (validateBeforeMutation?.(after) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (!previousTabId || previousTabId === ownedTabId || !previousTab)
                return Effect.void;
              const previousTabs = after.tabs.filter((tab) => tab.tabId === previousTabId);
              const ownedTabs = after.tabs.filter((tab) => tab.tabId === ownedTabId);
              const currentPrevious = previousTabs[0];
              const currentOwned = ownedTabs[0];
              const previousIdentityMatches =
                previousTabs.length === 1 &&
                currentPrevious?.workspaceId === previousTab.workspaceId &&
                currentPrevious.label === previousTab.label;
              const ownedFocusMatches =
                ownedTabs.length === 1 &&
                after.focusedTabId === ownedTabId &&
                (after.focusedWorkspaceId === undefined ||
                  after.focusedWorkspaceId === currentOwned?.workspaceId);
              return previousIdentityMatches && ownedFocusMatches
                ? cli.focusTab(previousTabId, "restore focus")
                : Effect.void;
            }),
          ),
        ),
      ),
    );
  };

  return {
    inspectProvisionalPane,
    requireAvailableProvisionalPane,
    waitForAvailableShell,
    activatePaneInput,
    confirmShellInput,
    restoreFocus,
  };
};
