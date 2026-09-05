import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { HerdrClient, type HerdrPane } from "../boundary/herdr-client.ts";
import type { HerdrBtwLinkRecordResult, HerdrBtwLinkStore } from "../boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../boundary/host-session.ts";
import {
  compareSessionFileIdentity as compareSessionFileIdentityAtBoundary,
  createBlankChildSessionFile as createBlankChildSessionFileAtBoundary,
  createChildSessionId as createChildSessionIdAtBoundary,
  probeSessionHeader as probeSessionHeaderAtBoundary,
  type BlankChildSessionFileInput,
  type BlankChildSessionFileResult,
  type SessionFileIdentityComparator,
  type SessionHeaderProbe,
} from "../boundary/session-file.ts";
import { HerdrBtwError } from "./errors.ts";
import type { HerdrBtwLink } from "./link.ts";
import { parseHerdrBtwSessionId } from "./marker.ts";
import {
  makeAgentName,
  parentBtwDisplayName,
  selectSplitDirection,
  sideSessionPrompt,
} from "./policy.ts";
import {
  ensureHerdrProtocol,
  ensurePiIntegration,
  isExactLinkedAgent,
  isLinkedAgentConflictCandidate,
  isValidBlankChildProbe,
  validateBtwInput,
  isDistinctChildSessionPath,
  validateStartedAgent,
  waitForAvailableShell,
} from "./validation.ts";

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
  readonly probeSessionHeader?: ((path: string) => SessionHeaderProbe) | undefined;
  readonly compareSessionFileIdentity?: SessionFileIdentityComparator | undefined;
  readonly createChildSessionId?: (() => string) | undefined;
  readonly createBlankChildSessionFile?:
    | ((input: BlankChildSessionFileInput) => Effect.Effect<BlankChildSessionFileResult>)
    | undefined;
}

const failClosedLink = (operation: string, code: string, message: string): HerdrBtwError =>
  new HerdrBtwError({
    operation,
    code,
    message: `${message} ${NEW_COMMAND_GUIDANCE}`,
    outcome: "confirmed",
  });

const linkRecordFailure = (result: Exclude<HerdrBtwLinkRecordResult, "recorded">): HerdrBtwError =>
  result === "refused"
    ? new HerdrBtwError({
        operation: "record BTW link",
        code: "herdr_btw_link_record_refused",
        message:
          "The side session started, but its reusable link was not recorded because the parent session changed or became unavailable before the append. Any prior reusable link remains authoritative.",
        outcome: "confirmed",
      })
    : new HerdrBtwError({
        operation: "record BTW link",
        code: "herdr_btw_link_record_outcome_uncertain",
        message:
          "The side session started, but Pi couldn't confirm whether its link was saved. Inspect the open pane and parent conversation before retrying the command.",
        outcome: "uncertain",
      });

type LaunchTarget =
  | { readonly mode: "create"; readonly childSessionId: string }
  | { readonly mode: "resume"; readonly link: HerdrBtwLink };

interface PreparedCreateTarget {
  readonly mode: "create";
  readonly childSessionId: string;
  readonly childSessionPath: string;
}

export const makeHerdrBtwService = (
  input: HerdrBtwSessionInput & { readonly linkStore: HerdrBtwLinkStore },
  options: HerdrBtwServiceOptions = {},
) =>
  Effect.gen(function* () {
    // One permit serializes commands in this runtime. Fresh Herdr snapshots
    // separately guard observed live-session reuse across runtimes.
    const gate = yield* Semaphore.make(1);
    const herdr = yield* HerdrClient;
    const linkStore = input.linkStore;
    const probeSessionHeader = options.probeSessionHeader ?? probeSessionHeaderAtBoundary;
    const compareSessionFileIdentity =
      options.compareSessionFileIdentity ?? compareSessionFileIdentityAtBoundary;
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
        const created = yield* createBlankChildSessionFile({
          sessionDir,
          cwd: input.cwd,
          sessionId: childSessionId,
        });
        if (created._tag !== "created")
          return yield* new HerdrBtwError({
            operation: "create blank child session",
            code: "herdr_btw_child_create_failed",
            message: "Unable to create the blank child Pi session file.",
            outcome: "confirmed",
          });
        const probe = probeSessionHeader(created.path);
        if (!isValidBlankChildProbe(probe, childSessionId))
          return yield* new HerdrBtwError({
            operation: "create blank child session",
            code: "herdr_btw_child_create_invalid",
            message: "The created blank child Pi session file failed validation.",
            outcome: "confirmed",
          });
        return { mode: "create", childSessionId, childSessionPath: created.path };
      });

    const deliverAndFocus = (
      agentName: string,
      paneId: string,
      prompt: string | undefined,
    ): Effect.Effect<void, HerdrBtwError> =>
      Effect.gen(function* () {
        const promptResult =
          prompt === undefined
            ? undefined
            : yield* Effect.result(herdr.promptSideSessionPi(agentName, sideSessionPrompt(prompt)));
        // Focus is attempted after prompt settlement even when prompt delivery
        // failed or its mutation outcome is uncertain.
        const focusResult = yield* Effect.result(herdr.focusSideSessionPi(agentName));
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
        yield* ensurePiIntegration(herdr);

        const parentPane = yield* herdr.resolveCallingPane();
        const layout = yield* herdr.inspectPaneLayout(parentPane.pane_id);
        if (layout.workspace_id !== parentPane.workspace_id || layout.tab_id !== parentPane.tab_id)
          return yield* new HerdrBtwError({
            operation: "inspect calling pane layout",
            code: "herdr_parent_topology_mismatch",
            message: "The calling pane changed workspace or tab while its layout was inspected.",
            outcome: "confirmed",
          });

        const direction = selectSplitDirection(layout.area.width);
        const btwPane = yield* herdr.splitPane({
          parentPaneId: parentPane.pane_id,
          direction,
          cwd: input.cwd,
        });
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

          yield* waitForAvailableShell(herdr, btwPane.pane_id);

          const preparedTarget =
            target.mode === "create"
              ? yield* prepareFreshLaunchTarget(target.childSessionId)
              : target;
          const agentName = makeAgentName(sessionId, btwPane.pane_id);
          const childSessionId =
            preparedTarget.mode === "create"
              ? preparedTarget.childSessionId
              : preparedTarget.link.childSessionId;
          const childSessionPath =
            preparedTarget.mode === "create"
              ? preparedTarget.childSessionPath
              : preparedTarget.link.childSessionPath;
          if (
            !isDistinctChildSessionPath(childSessionPath, sessionFile, compareSessionFileIdentity)
          )
            return yield* new HerdrBtwError({
              operation: "validate child session identity",
              code: "herdr_btw_child_identity_invalid",
              message:
                "The child session file was unavailable or resolved to the parent session file. No Pi launch was attempted.",
              outcome: "confirmed",
            });
          if (preparedTarget.mode === "resume") {
            const newlyLive = (yield* herdr.inspectLiveAgents()).filter((agent) =>
              isLinkedAgentConflictCandidate(
                agent,
                preparedTarget.link.agentName,
                preparedTarget.link.childSessionId,
                preparedTarget.link.childSessionPath,
                compareSessionFileIdentity,
              ),
            );
            if (newlyLive.length > 0)
              return yield* failClosedLink(
                "revalidate linked child session",
                "herdr_btw_live_agent_race",
                "The linked child session became live while its new pane was being prepared; no second Pi was started.",
              );
          }
          const startedAgent = yield* herdr.startSideSessionPi({
            agentName,
            paneId: btwPane.pane_id,
            childSessionId,
            childSessionPath,
            parentSessionId: sessionId,
            parentSessionPath: sessionFile,
            displayName:
              preparedTarget.mode === "create" ? parentBtwDisplayName(input.cwd) : undefined,
          });
          yield* validateStartedAgent(
            startedAgent,
            btwPane,
            agentName,
            sessionFile,
            childSessionPath,
            compareSessionFileIdentity,
          );
          const childProbe = probeSessionHeader(childSessionPath);
          if (!isValidBlankChildProbe(childProbe, childSessionId))
            return yield* new HerdrBtwError({
              operation: "validate started child session",
              code: "herdr_btw_child_invalid",
              message:
                "The Herdr side session started, but its blank child session file no longer matched the launch.",
              outcome: "confirmed",
            });

          // The link is superseded only after confirmed startup and child-file
          // validation; every earlier failure keeps the prior link authoritative.
          const recordResult = linkStore.record({
            childSessionId,
            childSessionPath,
            agentName,
            terminalId: startedAgent.terminal_id,
          });
          if (recordResult !== "recorded") return yield* linkRecordFailure(recordResult);

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

    const openFreshCreate = (
      prompt: string | undefined,
      sessionFile: string,
      sessionId: string,
    ): Effect.Effect<HerdrBtwResult, HerdrBtwError> =>
      Effect.gen(function* () {
        const childSessionId = yield* freshChildSessionId;
        yield* ensureHerdrProtocol(herdr);
        return yield* launch({ mode: "create", childSessionId }, prompt, sessionFile, sessionId);
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
          !isExactLinkedAgent(
            live,
            link.agentName,
            link.terminalId,
            link.childSessionId,
            link.childSessionPath,
            compareSessionFileIdentity,
          )
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
      const { sessionFile, sessionId } = yield* validateBtwInput(prompt, input, probeSessionHeader);
      const restoration = linkStore.restore();
      if (restoration._tag === "malformed")
        return yield* failClosedLink(
          "restore BTW link",
          "herdr_btw_link_malformed",
          "The recorded BTW link in this session is unreadable.",
        );
      if (restoration._tag === "none")
        return yield* openFreshCreate(prompt, sessionFile, sessionId);

      // The link store has already filtered copied ancestor entries against the
      // captured owner before returning a restored link.
      const link = restoration.link;
      const probe = probeSessionHeader(link.childSessionPath);
      if (
        !isValidBlankChildProbe(probe, link.childSessionId) ||
        !isDistinctChildSessionPath(link.childSessionPath, sessionFile, compareSessionFileIdentity)
      )
        return yield* failClosedLink(
          "validate linked child session",
          "herdr_btw_link_child_invalid",
          "The linked child session file is missing, replaced, or no longer matches the recorded blank side session.",
        );

      yield* ensureHerdrProtocol(herdr);
      const liveAgents = (yield* herdr.inspectLiveAgents()).filter((agent) =>
        isLinkedAgentConflictCandidate(
          agent,
          link.agentName,
          link.childSessionId,
          link.childSessionPath,
          compareSessionFileIdentity,
        ),
      );
      if (liveAgents.length > 0) return yield* focusLiveAgent(link, liveAgents, prompt);
      return yield* launch({ mode: "resume", link }, prompt, sessionFile, sessionId);
    });

    const openNewInner = Effect.fn("HerdrBtwService.openNew")(function* (
      prompt?: string | undefined,
    ) {
      const { sessionFile, sessionId } = yield* validateBtwInput(prompt, input, probeSessionHeader);
      return yield* openFreshCreate(prompt, sessionFile, sessionId);
    });

    return {
      open: (prompt?: string | undefined) => gate.withPermit(openInner(prompt)),
      openNew: (prompt?: string | undefined) => gate.withPermit(openNewInner(prompt)),
    };
  });

export type HerdrBtwServiceContract = Effect.Success<ReturnType<typeof makeHerdrBtwService>>;

export class HerdrBtwService extends Context.Service<HerdrBtwService, HerdrBtwServiceContract>()(
  "pi-herdr-btw/btw/service/HerdrBtwService",
) {}
