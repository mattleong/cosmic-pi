import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  AgentEnvelopeSchema,
  LayoutEnvelopeSchema,
  PaneEnvelopeSchema,
  SnapshotEnvelopeSchema,
  herdrCommand,
  makeHerdrCommandRunner,
  type HerdrCommandRunner,
  type HerdrPane,
} from "../boundary/herdr-client.ts";
import type { HerdrBtwLinkStore } from "../boundary/host-link-store.ts";
import {
  isValidParentSessionFile,
  parentBtwDisplayName,
  type HerdrBtwSessionInput,
} from "../boundary/host-session.ts";
import {
  createBlankChildSessionFile as createBlankChildSessionFileAtBoundary,
  createChildSessionId as createChildSessionIdAtBoundary,
  probeSessionHeader as probeSessionHeaderAtBoundary,
  type BlankChildSessionFileInput,
  type BlankChildSessionFileResult,
  type SessionHeaderProbe,
} from "../boundary/session-file.ts";
import { HerdrBtwError } from "./errors.ts";
import type { HerdrBtwLink } from "./link.ts";
import { herdrBtwParentMarkerArguments, parseHerdrBtwSessionId } from "./marker.ts";
import { makeAgentName, selectSplitDirection, sideSessionPrompt } from "./policy.ts";
import {
  agentChildSessionPath,
  ensureHerdrProtocol,
  ensurePiIntegration,
  validateBtwInput,
  validateStartedAgent,
  waitForAvailableShell,
} from "./validation.ts";

const START_TIMEOUT_MILLIS = 70_000;
const NEW_COMMAND_GUIDANCE = "Run /herdr-btw:new to create a fresh BTW session.";

const retainPaneFailure = (
  failure: HerdrBtwError,
  paneId: string,
  guidance: string = `Pane ${paneId} was retained for manual inspection.`,
): HerdrBtwError =>
  failure.paneId === paneId
    ? failure
    : new HerdrBtwError({ ...failure, paneId, message: `${failure.message} ${guidance}` });

export type HerdrBtwResultMode = "created" | "resumed" | "focused";

export interface HerdrBtwResult {
  readonly agentName: string;
  readonly paneId: string;
  readonly mode: HerdrBtwResultMode;
  readonly prompted: boolean;
  readonly direction?: "right" | "down" | undefined;
}

interface HerdrBtwServiceOptions {
  readonly runner?: HerdrCommandRunner | undefined;
  readonly validateSessionFile?: ((path: string) => boolean) | undefined;
  readonly probeSessionHeader?: ((path: string) => SessionHeaderProbe) | undefined;
  readonly createChildSessionId?: (() => string) | undefined;
  readonly createBlankChildSessionFile?:
    | ((input: BlankChildSessionFileInput) => BlankChildSessionFileResult)
    | undefined;
}

const failClosedLink = (operation: string, code: string, message: string): HerdrBtwError =>
  new HerdrBtwError({
    operation,
    code,
    message: `${message} ${NEW_COMMAND_GUIDANCE}`,
    outcome: "confirmed",
  });

type LaunchTarget =
  | { readonly mode: "create"; readonly childSessionId: string }
  | { readonly mode: "resume"; readonly link: HerdrBtwLink };

interface PreparedCreateTarget {
  readonly mode: "create";
  readonly childSessionId: string;
  readonly childSessionPath: string;
}

export interface HerdrBtwServiceContract {
  readonly open: (prompt?: string | undefined) => Effect.Effect<HerdrBtwResult, HerdrBtwError>;
  readonly openNew: (prompt?: string | undefined) => Effect.Effect<HerdrBtwResult, HerdrBtwError>;
}

export const makeHerdrBtwService = (
  input: HerdrBtwSessionInput,
  linkStore: HerdrBtwLinkStore,
  options: HerdrBtwServiceOptions = {},
): Effect.Effect<HerdrBtwServiceContract> =>
  Effect.gen(function* () {
    // One permit serializes commands in this runtime. Fresh Herdr snapshots
    // separately guard observed live-session reuse across runtimes.
    const gate = yield* Semaphore.make(1);
    const runner = options.runner ?? makeHerdrCommandRunner(input.environment);
    const validateSessionFile = options.validateSessionFile ?? isValidParentSessionFile;
    const probeSessionHeader = options.probeSessionHeader ?? probeSessionHeaderAtBoundary;
    const createChildSessionId = options.createChildSessionId ?? createChildSessionIdAtBoundary;
    const createBlankChildSessionFile =
      options.createBlankChildSessionFile ?? createBlankChildSessionFileAtBoundary;

    const freshChildSessionId = Effect.gen(function* () {
      const childSessionId = createChildSessionId();
      if (parseHerdrBtwSessionId(childSessionId) === undefined)
        return yield* new HerdrBtwError({
          operation: "validate side Pi session",
          code: "herdr_btw_child_id_invalid",
          message: "The preassigned child session ID is not a valid Pi session ID.",
          outcome: "confirmed",
        });
      return childSessionId;
    });

    const prepareFreshLaunchTarget = (
      childSessionId: string,
    ): Effect.Effect<PreparedCreateTarget, HerdrBtwError> =>
      Effect.gen(function* () {
        const sessionDir = input.sessionDir;
        if (!sessionDir)
          return yield* new HerdrBtwError({
            operation: "create blank child session",
            code: "herdr_btw_session_directory_unavailable",
            message: "The parent Pi session directory is unavailable.",
            outcome: "confirmed",
          });
        const created = yield* Effect.try({
          try: () =>
            createBlankChildSessionFile({
              sessionDir,
              cwd: input.cwd,
              sessionId: childSessionId,
            }),
          catch: () =>
            new HerdrBtwError({
              operation: "create blank child session",
              code: "herdr_btw_child_create_failed",
              message: "Unable to create the blank child Pi session file.",
              outcome: "confirmed",
            }),
        });
        if (created._tag !== "created")
          return yield* new HerdrBtwError({
            operation: "create blank child session",
            code: "herdr_btw_child_create_failed",
            message: "Unable to create the blank child Pi session file.",
            outcome: "confirmed",
          });
        const probe = probeSessionHeader(created.path);
        if (
          probe._tag !== "valid" ||
          probe.header.id !== childSessionId ||
          probe.header.parentSession !== undefined
        )
          return yield* new HerdrBtwError({
            operation: "create blank child session",
            code: "herdr_btw_child_create_invalid",
            message: "The created blank child Pi session file failed validation.",
            outcome: "confirmed",
          });
        return { mode: "create", childSessionId, childSessionPath: created.path };
      });

    const freshSnapshotAgents = Effect.suspend(() =>
      Effect.map(
        herdrCommand(runner, {
          args: ["api", "snapshot"],
          operation: "inspect live agents",
          schema: SnapshotEnvelopeSchema,
        }),
        ({ result }) => result.snapshot.agents,
      ),
    );

    const deliverAndFocus = (
      agentName: string,
      paneId: string,
      prompt: string | undefined,
    ): Effect.Effect<void, HerdrBtwError> =>
      Effect.gen(function* () {
        const promptResult =
          prompt === undefined
            ? undefined
            : yield* Effect.result(
                runner({
                  args: ["agent", "prompt", agentName, sideSessionPrompt(prompt)],
                  operation: "prompt side-session Pi",
                  mutation: true,
                }),
              );
        const focusResult = yield* Effect.result(
          runner({
            args: ["agent", "focus", agentName],
            operation: "focus side-session Pi",
            mutation: true,
          }),
        );
        if (promptResult?._tag === "Failure")
          return yield* retainPaneFailure(
            promptResult.failure,
            paneId,
            `The side session is running in pane ${paneId}; enter the prompt there manually.`,
          );
        if (focusResult._tag === "Failure")
          return yield* retainPaneFailure(
            focusResult.failure,
            paneId,
            `The side session is running in pane ${paneId}; focus it manually.`,
          );
      });

    const launch = (
      target: LaunchTarget,
      prompt: string | undefined,
      sessionFile: string,
      sessionId: string,
    ): Effect.Effect<HerdrBtwResult, HerdrBtwError> =>
      Effect.gen(function* () {
        yield* ensurePiIntegration(runner);

        const parentPane = (yield* herdrCommand(runner, {
          args: ["pane", "current", "--current"],
          operation: "resolve calling pane",
          schema: PaneEnvelopeSchema,
        })).result.pane;
        const { result: layoutResult } = yield* herdrCommand(runner, {
          args: ["pane", "layout", "--pane", parentPane.pane_id],
          operation: "inspect calling pane layout",
          schema: LayoutEnvelopeSchema,
        });
        if (
          layoutResult.layout.workspace_id !== parentPane.workspace_id ||
          layoutResult.layout.tab_id !== parentPane.tab_id
        )
          return yield* new HerdrBtwError({
            operation: "inspect calling pane layout",
            code: "herdr_parent_topology_mismatch",
            message: "The calling pane changed workspace or tab while its layout was inspected.",
            outcome: "confirmed",
          });

        const direction = selectSplitDirection(layoutResult.layout.area.width);
        const btwPane = (yield* herdrCommand(runner, {
          args: [
            "pane",
            "split",
            parentPane.pane_id,
            "--direction",
            direction,
            "--ratio",
            "0.5",
            "--cwd",
            input.cwd,
            "--no-focus",
          ],
          operation: "split BTW pane",
          mutation: true,
          schema: PaneEnvelopeSchema,
        })).result.pane;
        return yield* Effect.gen(function* () {
          if (
            btwPane.pane_id === parentPane.pane_id ||
            btwPane.workspace_id !== parentPane.workspace_id ||
            btwPane.tab_id !== parentPane.tab_id
          )
            return yield* new HerdrBtwError({
              operation: "split BTW pane",
              code: "herdr_split_topology_mismatch",
              message:
                "Herdr returned a pane outside the calling pane's current workspace/tab; no further action was taken.",
              outcome: "uncertain",
            });

          yield* waitForAvailableShell(runner, btwPane.pane_id);

          const preparedTarget =
            target.mode === "create"
              ? yield* prepareFreshLaunchTarget(target.childSessionId)
              : target;
          const agentName = makeAgentName(sessionId, btwPane.pane_id);
          const displayName = parentBtwDisplayName(input.cwd);
          const childSessionId =
            preparedTarget.mode === "create"
              ? preparedTarget.childSessionId
              : preparedTarget.link.childSessionId;
          const childSessionPath =
            preparedTarget.mode === "create"
              ? preparedTarget.childSessionPath
              : preparedTarget.link.childSessionPath;
          const markerArguments = herdrBtwParentMarkerArguments(
            sessionId,
            sessionFile,
            childSessionId,
          );
          if (preparedTarget.mode === "resume") {
            const newlyLive = (yield* freshSnapshotAgents).filter(
              (agent) => agentChildSessionPath(agent) === preparedTarget.link.childSessionPath,
            );
            if (newlyLive.length > 0)
              return yield* failClosedLink(
                "revalidate linked child session",
                "herdr_btw_live_agent_race",
                "The linked child session became live while its new pane was being prepared; no second Pi was started.",
              );
          }
          const piArguments =
            preparedTarget.mode === "create"
              ? ["--session", childSessionPath, "--name", displayName, ...markerArguments]
              : ["--session", childSessionPath, ...markerArguments];
          const { result: startedResult } = yield* herdrCommand(runner, {
            args: [
              "agent",
              "start",
              agentName,
              "--kind",
              "pi",
              "--pane",
              btwPane.pane_id,
              "--timeout",
              "60000",
              "--",
              ...piArguments,
            ],
            operation: "start side-session Pi",
            mutation: true,
            timeoutMillis: START_TIMEOUT_MILLIS,
            confirmedRejectionCodes: ["agent_pane_busy"],
            schema: AgentEnvelopeSchema,
          });
          yield* validateStartedAgent(
            startedResult.agent,
            btwPane,
            agentName,
            sessionFile,
            childSessionPath,
          );
          const childProbe = probeSessionHeader(childSessionPath);
          if (
            childProbe._tag !== "valid" ||
            childProbe.header.id !== childSessionId ||
            childProbe.header.parentSession !== undefined
          )
            return yield* new HerdrBtwError({
              operation: "validate started child session",
              code: "herdr_btw_child_invalid",
              message:
                "The Herdr side session started, but its blank child session file no longer matched the launch.",
              outcome: "confirmed",
            });

          // The link is superseded only after confirmed startup and child-file
          // validation; every earlier failure keeps the prior link authoritative.
          const recorded = linkStore.record({
            version: 1,
            parentSessionId: sessionId,
            parentSessionPath: sessionFile,
            childSessionId,
            childSessionPath,
            agentName,
            terminalId: startedResult.agent.terminal_id,
          });
          if (!recorded)
            return yield* new HerdrBtwError({
              operation: "record BTW link",
              code: "herdr_btw_link_record_failed",
              message:
                "The side session started, but its reusable link could not be recorded in the parent session. Any prior reusable link remains authoritative.",
              outcome: "confirmed",
            });

          yield* deliverAndFocus(agentName, btwPane.pane_id, prompt);

          const mode: HerdrBtwResultMode = preparedTarget.mode === "create" ? "created" : "resumed";
          return {
            agentName,
            paneId: btwPane.pane_id,
            mode,
            prompted: prompt !== undefined,
            direction,
          };
        }).pipe(Effect.mapError((failure) => retainPaneFailure(failure, btwPane.pane_id)));
      });

    const focusLiveAgent = (
      link: HerdrBtwLink,
      liveAgents: ReadonlyArray<HerdrPane>,
      prompt: string | undefined,
    ): Effect.Effect<HerdrBtwResult, HerdrBtwError> =>
      Effect.gen(function* () {
        const live = liveAgents[0];
        if (
          liveAgents.length !== 1 ||
          live === undefined ||
          live.name !== link.agentName ||
          live.terminal_id !== link.terminalId ||
          live.agent !== "pi"
        )
          return yield* failClosedLink(
            "validate live BTW agent",
            "herdr_btw_live_agent_ambiguous",
            "A live Herdr agent on the linked child session did not match the recorded BTW identity.",
          );
        yield* deliverAndFocus(link.agentName, live.pane_id, prompt);
        const mode: HerdrBtwResultMode = "focused";
        return {
          agentName: link.agentName,
          paneId: live.pane_id,
          mode,
          prompted: prompt !== undefined,
        };
      });

    const openInner = Effect.fn("HerdrBtwService.open")(function* (prompt?: string | undefined) {
      const { sessionFile, sessionId } = yield* validateBtwInput(
        prompt,
        input,
        validateSessionFile,
      );
      const restoration = linkStore.restore();
      if (restoration._tag === "malformed")
        return yield* failClosedLink(
          "restore BTW link",
          "herdr_btw_link_malformed",
          "The recorded BTW link in this session is unreadable.",
        );
      if (restoration._tag === "none") {
        const childSessionId = yield* freshChildSessionId;
        yield* ensureHerdrProtocol(runner);
        return yield* launch({ mode: "create", childSessionId }, prompt, sessionFile, sessionId);
      }

      const link = restoration.link;
      // Native forks copy custom entries. Ignore a reusable link inherited
      // from an ancestor session instead of adopting that ancestor's child.
      if (link.parentSessionId !== sessionId || link.parentSessionPath !== sessionFile) {
        const childSessionId = yield* freshChildSessionId;
        yield* ensureHerdrProtocol(runner);
        return yield* launch({ mode: "create", childSessionId }, prompt, sessionFile, sessionId);
      }

      const probe = probeSessionHeader(link.childSessionPath);
      if (
        link.childSessionPath === sessionFile ||
        probe._tag !== "valid" ||
        probe.header.id !== link.childSessionId ||
        probe.header.parentSession !== undefined
      )
        return yield* failClosedLink(
          "validate linked child session",
          "herdr_btw_link_child_invalid",
          "The linked child session file is missing, replaced, or no longer matches the recorded blank side session.",
        );

      yield* ensureHerdrProtocol(runner);
      const liveAgents = (yield* freshSnapshotAgents).filter(
        (agent) => agentChildSessionPath(agent) === link.childSessionPath,
      );
      if (liveAgents.length > 0) return yield* focusLiveAgent(link, liveAgents, prompt);
      return yield* launch({ mode: "resume", link }, prompt, sessionFile, sessionId);
    });

    const openNewInner = Effect.fn("HerdrBtwService.openNew")(function* (
      prompt?: string | undefined,
    ) {
      const { sessionFile, sessionId } = yield* validateBtwInput(
        prompt,
        input,
        validateSessionFile,
      );
      const childSessionId = yield* freshChildSessionId;
      yield* ensureHerdrProtocol(runner);
      return yield* launch({ mode: "create", childSessionId }, prompt, sessionFile, sessionId);
    });

    const serialized = gate.withPermits(1);
    return {
      open: (prompt?: string | undefined) => serialized(openInner(prompt)),
      openNew: (prompt?: string | undefined) => serialized(openNewInner(prompt)),
    } satisfies HerdrBtwServiceContract;
  });

export class HerdrBtwService extends Context.Service<HerdrBtwService, HerdrBtwServiceContract>()(
  "pi-herdr-btw/btw/service/HerdrBtwService",
) {}
