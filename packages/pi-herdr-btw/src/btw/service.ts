import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { HerdrClient, type HerdrPane } from "../boundary/herdr-client.ts";
import type { HerdrBtwLinkRecordResult, HerdrBtwLinkStore } from "../boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../boundary/host-session.ts";
import {
  compareSessionFileIdentity,
  createBlankChildSessionFile,
  createChildSessionId,
  probeSessionHeader,
} from "../boundary/session-file.ts";
import { confirmedFailure, HerdrBtwError } from "./errors.ts";
import type { HerdrBtwLink } from "./link.ts";
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

export const HERDR_BTW_COMMAND = "herdr-btw";
/** The fresh-session subcommand, typed after `/herdr-btw`. */
export const HERDR_BTW_NEW_SUBCOMMAND = "new";
const NEW_COMMAND_GUIDANCE = `Run /${HERDR_BTW_COMMAND} ${HERDR_BTW_NEW_SUBCOMMAND} to start a fresh side session`;

const retainPaneFailure = (
  failure: HerdrBtwError,
  paneId: string,
  guidance = "the pane was left open for you to inspect",
): HerdrBtwError =>
  failure.paneId === paneId
    ? failure
    : new HerdrBtwError({ ...failure, paneId, message: `${failure.message}; ${guidance}` });

export interface HerdrBtwResult {
  readonly agentName: string;
  readonly paneId: string;
  readonly mode: "created" | "resumed" | "focused";
}

/** Session-file boundary defaults; the options parameter overrides them in tests. */
const sessionFileBoundary = {
  probeSessionHeader,
  compareSessionFileIdentity,
  createChildSessionId,
  createBlankChildSessionFile,
};

const failClosedLink = (operation: string, code: string, message: string): HerdrBtwError =>
  confirmedFailure(operation, code, `${message}; ${NEW_COMMAND_GUIDANCE.toLowerCase()}`);

const linkRecordFailure = (result: Exclude<HerdrBtwLinkRecordResult, "recorded">): HerdrBtwError =>
  result === "refused"
    ? confirmedFailure(
        "record BTW link",
        "herdr_btw_link_record_refused",
        "The side session started, but its link wasn't saved because this session changed; your previous side session stays linked",
      )
    : new HerdrBtwError({
        operation: "record BTW link",
        code: "herdr_btw_link_record_outcome_uncertain",
        message:
          "The side session started, but Pi couldn't confirm its link was saved; check the open pane before trying again",
        outcome: "uncertain",
      });

type LaunchTarget =
  | { readonly mode: "create"; readonly childSessionId: string }
  | { readonly mode: "resume"; readonly link: HerdrBtwLink };

export const makeHerdrBtwService = (
  input: HerdrBtwSessionInput & { readonly linkStore: HerdrBtwLinkStore },
  options: Partial<typeof sessionFileBoundary> = {},
) =>
  Effect.gen(function* () {
    // One permit serializes commands in this runtime. Fresh Herdr snapshots
    // separately guard observed live-session reuse across runtimes.
    const gate = yield* Semaphore.make(1);
    const herdr = yield* HerdrClient;
    const linkStore = input.linkStore;
    const {
      probeSessionHeader,
      compareSessionFileIdentity,
      createChildSessionId,
      createBlankChildSessionFile,
    } = { ...sessionFileBoundary, ...options };

    const prepareFreshLaunchTarget = (
      childSessionId: string,
    ): Effect.Effect<Pick<HerdrBtwLink, "childSessionId" | "childSessionPath">, HerdrBtwError> =>
      Effect.gen(function* () {
        const sessionDir = input.sessionDir;
        if (!sessionDir)
          return yield* confirmedFailure(
            "create blank child session",
            "herdr_btw_session_directory_unavailable",
            "Couldn't find this session's folder",
          );
        const created = yield* createBlankChildSessionFile({
          sessionDir,
          cwd: input.cwd,
          sessionId: childSessionId,
        });
        if (created._tag !== "created")
          return yield* confirmedFailure(
            "create blank child session",
            "herdr_btw_child_create_failed",
            "Couldn't create the side session's file",
          );
        const probe = probeSessionHeader(created.path);
        if (!isValidBlankChildProbe(probe, childSessionId))
          return yield* confirmedFailure(
            "create blank child session",
            "herdr_btw_child_create_invalid",
            "The side session's new file didn't pass its checks",
          );
        return { childSessionId, childSessionPath: created.path };
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
            "The side session is running; type your prompt there",
          );
        if (focusResult._tag === "Failure")
          return yield* retainPaneFailure(
            focusResult.failure,
            paneId,
            "The side session is running; switch to its pane to use it",
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
          return yield* confirmedFailure(
            "inspect calling pane layout",
            "herdr_parent_topology_mismatch",
            "Your pane moved to another workspace or tab while it was being checked",
          );

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
                "Herdr opened the pane in a different workspace or tab, so nothing else was done",
              outcome: "uncertain",
            });

          yield* waitForAvailableShell(herdr, btwPane.pane_id);

          const { childSessionId, childSessionPath } =
            target.mode === "create"
              ? yield* prepareFreshLaunchTarget(target.childSessionId)
              : target.link;
          const agentName = makeAgentName(sessionId, btwPane.pane_id);
          if (
            !isDistinctChildSessionPath(childSessionPath, sessionFile, compareSessionFileIdentity)
          )
            return yield* confirmedFailure(
              "validate child session identity",
              "herdr_btw_child_identity_invalid",
              "Couldn't prepare a separate session file, so Pi wasn't started",
            );
          if (target.mode === "resume") {
            const newlyLive = (yield* herdr.inspectLiveAgents()).filter((agent) =>
              isLinkedAgentConflictCandidate(agent, target.link, compareSessionFileIdentity),
            );
            if (newlyLive.length > 0)
              return yield* failClosedLink(
                "revalidate linked child session",
                "herdr_btw_live_agent_race",
                "The side session started elsewhere while its pane was being prepared, so a second one wasn't started",
              );
          }
          const startedAgent = yield* herdr.startSideSessionPi({
            agentName,
            paneId: btwPane.pane_id,
            childSessionId,
            childSessionPath,
            parentSessionId: sessionId,
            parentSessionPath: sessionFile,
            displayName: target.mode === "create" ? parentBtwDisplayName(input.cwd) : undefined,
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
            return yield* confirmedFailure(
              "validate started child session",
              "herdr_btw_child_invalid",
              "The side session started, but its file changed unexpectedly",
            );

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

          const mode: HerdrBtwResult["mode"] = target.mode === "create" ? "created" : "resumed";
          return { agentName, paneId: btwPane.pane_id, mode };
        }).pipe(Effect.mapError((failure) => retainPaneFailure(failure, btwPane.pane_id)));
      });

    const openFreshCreate = (
      prompt: string | undefined,
      sessionFile: string,
      sessionId: string,
    ): Effect.Effect<HerdrBtwResult, HerdrBtwError> =>
      Effect.gen(function* () {
        const childSessionId = createChildSessionId();
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
          !isExactLinkedAgent(live, link, compareSessionFileIdentity)
        )
          return yield* failClosedLink(
            "validate live BTW agent",
            "herdr_btw_live_agent_ambiguous",
            "Another Pi is already using the linked side session",
          );
        yield* deliverAndFocus(link.agentName, live.pane_id, prompt);
        return { agentName: link.agentName, paneId: live.pane_id, mode: "focused" };
      });

    const openInner = Effect.fn("HerdrBtwService.open")(function* (prompt?: string | undefined) {
      const { sessionFile, sessionId } = yield* validateBtwInput(prompt, input, probeSessionHeader);
      const restoration = linkStore.restore();
      if (restoration._tag === "malformed")
        return yield* failClosedLink(
          "restore BTW link",
          "herdr_btw_link_malformed",
          "This session's side-session link is unreadable",
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
          "The linked side session's file is missing or was replaced",
        );

      yield* ensureHerdrProtocol(herdr);
      const liveAgents = (yield* herdr.inspectLiveAgents()).filter((agent) =>
        isLinkedAgentConflictCandidate(agent, link, compareSessionFileIdentity),
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
