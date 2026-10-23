import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { HerdrClient, type HerdrPane } from "../boundary/herdr-client.ts";
import { HerdrBtwLinkStore, type HerdrBtwLinkRecordResult } from "../boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../boundary/host-session.ts";
import { BlankChildSessionFileResult, HerdrSessionFiles } from "../boundary/session-file.ts";
import { confirmedFailure, HerdrBtwError, uncertainFailure } from "./errors.ts";
import { HerdrBtwLinkRestoration, type HerdrBtwLink } from "./link.ts";
import {
  parentBtwDisplayName,
  selectSplitDirection,
  sideSessionAgentName,
  sideSessionPrompt,
} from "./policy.ts";
import {
  ensureHerdrProtocol,
  ensurePiIntegration,
  isExactLinkedAgent,
  isLinkedAgentConflictCandidate,
  isOwnedStartedAgent,
  isValidBlankChildProbe,
  validateBtwInput,
  isDistinctChildSessionPath,
  waitForAvailableShell,
} from "./validation.ts";

export const HERDR_BTW_COMMAND = "herdr-btw";
export const HERDR_BTW_NEW_SUBCOMMAND = "new";
const NEW_COMMAND_GUIDANCE = `Run /${HERDR_BTW_COMMAND} ${HERDR_BTW_NEW_SUBCOMMAND} to start a fresh side session`;

const retainPaneFailure = (
  failure: HerdrBtwError,
  paneId: string,
  guidance = "the pane was left open for you to inspect",
): HerdrBtwError =>
  failure.paneId === paneId
    ? failure
    : HerdrBtwError.make({
        operation: failure.operation,
        code: failure.code,
        outcome: failure.outcome,
        paneId,
        message: `${failure.message}; ${guidance}`,
      });

export interface HerdrBtwResult {
  readonly agentName: string;
  readonly paneId: string;
  readonly mode: "created" | "resumed" | "focused";
}

const failClosedLink = (operation: string, code: string, message: string): HerdrBtwError =>
  confirmedFailure(operation, code, `${message}; ${NEW_COMMAND_GUIDANCE.toLowerCase()}`);

const linkRecordFailure = (result: Exclude<HerdrBtwLinkRecordResult, "recorded">): HerdrBtwError =>
  result === "refused"
    ? confirmedFailure(
        "record BTW link",
        "herdr_btw_link_record_refused",
        "The side session started, but its link wasn't saved because this session changed; your previous side session stays linked",
      )
    : uncertainFailure(
        "record BTW link",
        "herdr_btw_link_record_outcome_uncertain",
        "The side session started, but Pi couldn't confirm its link was saved; check the open pane before trying again",
      );

type LaunchTarget =
  | { readonly mode: "create"; readonly childSessionId: string }
  | { readonly mode: "resume"; readonly link: HerdrBtwLink };

const makeHerdrBtwService = Effect.fn("HerdrBtwService.make")(function* (
  input: HerdrBtwSessionInput,
) {
  const gate = yield* Semaphore.make(1);
  const herdr = yield* HerdrClient;
  const linkStore = yield* HerdrBtwLinkStore;
  const files = yield* HerdrSessionFiles;
  const isValidBlankChild = (path: string, childSessionId: string) =>
    files
      .probeSessionHeader(path)
      .pipe(Effect.map((probe) => isValidBlankChildProbe(probe, childSessionId)));

  const prepareFreshLaunchTarget = Effect.fn("HerdrBtwService.prepareFreshLaunchTarget")(function* (
    childSessionId: string,
  ) {
    const sessionDir = input.sessionDir;
    if (!sessionDir)
      return yield* confirmedFailure(
        "create blank child session",
        "herdr_btw_session_directory_unavailable",
        "Couldn't find this session's folder",
      );
    const created = yield* files.createBlankChildSessionFile({
      sessionDir,
      cwd: input.cwd,
      sessionId: childSessionId,
    });
    if (!BlankChildSessionFileResult.$is("created")(created))
      return yield* confirmedFailure(
        "create blank child session",
        "herdr_btw_child_create_failed",
        "Couldn't create the side session's file",
      );
    if (!(yield* isValidBlankChild(created.path, childSessionId)))
      return yield* confirmedFailure(
        "create blank child session",
        "herdr_btw_child_create_invalid",
        "The side session's new file didn't pass its checks",
      );
    return { childSessionId, childSessionPath: created.path };
  });

  const deliverAndFocus = Effect.fn("HerdrBtwService.deliverAndFocus")(function* (
    agentName: string,
    paneId: string,
    prompt: string | undefined,
  ) {
    const promptResult =
      prompt === undefined
        ? undefined
        : yield* Effect.result(herdr.promptSideSessionPi(agentName, sideSessionPrompt(prompt)));
    const focusResult = yield* Effect.result(herdr.focusSideSessionPi(agentName));
    if (promptResult !== undefined && Result.isFailure(promptResult))
      return yield* retainPaneFailure(
        promptResult.failure,
        paneId,
        "The side session is running; type your prompt there",
      );
    if (Result.isFailure(focusResult))
      return yield* retainPaneFailure(
        focusResult.failure,
        paneId,
        "The side session is running; switch to its pane to use it",
      );
    return undefined;
  });

  const launch = Effect.fn("HerdrBtwService.launch")(function* (
    target: LaunchTarget,
    prompt: string | undefined,
    sessionFile: string,
    sessionId: string,
  ) {
    yield* ensurePiIntegration(herdr);

    const parentPane = yield* herdr.resolveCallingPane();
    const layout = yield* herdr.inspectPaneLayout(parentPane.pane_id);
    if (layout.workspace_id !== parentPane.workspace_id || layout.tab_id !== parentPane.tab_id)
      return yield* confirmedFailure(
        "inspect calling pane layout",
        "herdr_parent_topology_mismatch",
        "Your pane moved to another workspace or tab while it was being checked",
      );

    const btwPane = yield* herdr.splitPane({
      parentPaneId: parentPane.pane_id,
      direction: selectSplitDirection(layout.area.width),
      cwd: input.cwd,
    });
    return yield* Effect.gen(function* () {
      if (
        btwPane.pane_id === parentPane.pane_id ||
        btwPane.workspace_id !== parentPane.workspace_id ||
        btwPane.tab_id !== parentPane.tab_id
      )
        return yield* uncertainFailure(
          "split BTW pane",
          "herdr_split_topology_mismatch",
          "Herdr opened the pane in a different workspace or tab, so nothing else was done",
        );

      yield* waitForAvailableShell(herdr, btwPane.pane_id);

      const { childSessionId, childSessionPath } =
        target.mode === "create"
          ? yield* prepareFreshLaunchTarget(target.childSessionId)
          : target.link;
      const agentName = sideSessionAgentName(sessionId, btwPane.pane_id);
      if (target.mode === "resume") {
        const newlyLive = yield* Effect.filter(yield* herdr.inspectLiveAgents(), (agent) =>
          isLinkedAgentConflictCandidate(files, agent, target.link),
        );
        if (newlyLive.length > 0)
          return yield* failClosedLink(
            "revalidate linked child session",
            "herdr_btw_live_agent_race",
            "The side session started elsewhere while its pane was being prepared, so a second one wasn't started",
          );
        if (!(yield* isValidBlankChild(childSessionPath, childSessionId)))
          return yield* failClosedLink(
            "validate linked child session",
            "herdr_btw_link_child_invalid",
            "The linked side session's file is missing or was replaced",
          );
      }
      if (!(yield* isDistinctChildSessionPath(files, childSessionPath, sessionFile)))
        return yield* confirmedFailure(
          "validate child session identity",
          "herdr_btw_child_identity_invalid",
          "Couldn't prepare a separate session file, so Pi wasn't started",
        );
      const startedAgent = yield* herdr.startSideSessionPi({
        agentName,
        paneId: btwPane.pane_id,
        childSessionId,
        childSessionPath,
        parentSessionId: sessionId,
        parentSessionPath: sessionFile,
        displayName: target.mode === "create" ? parentBtwDisplayName(input.cwd) : undefined,
      });
      if (
        !(yield* isOwnedStartedAgent(
          files,
          startedAgent,
          btwPane,
          agentName,
          sessionFile,
          childSessionPath,
        ))
      )
        return yield* uncertainFailure(
          "start side-session Pi",
          "herdr_agent_ownership_mismatch",
          "Herdr reported a different Pi starting than the one launched",
        );
      if (!(yield* isValidBlankChild(childSessionPath, childSessionId)))
        return yield* confirmedFailure(
          "validate started child session",
          "herdr_btw_child_invalid",
          "The side session started, but its file changed unexpectedly",
        );

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

  const openFreshCreate = Effect.fn("HerdrBtwService.openFreshCreate")(function* (
    prompt: string | undefined,
    sessionFile: string,
    sessionId: string,
  ) {
    const childSessionId = yield* files.createChildSessionId;
    yield* ensureHerdrProtocol(herdr);
    return yield* launch({ mode: "create", childSessionId }, prompt, sessionFile, sessionId);
  });

  const focusLiveAgent = Effect.fn("HerdrBtwService.focusLiveAgent")(function* (
    link: HerdrBtwLink,
    liveAgents: ReadonlyArray<HerdrPane>,
    prompt: string | undefined,
  ) {
    const live = liveAgents[0];
    if (
      liveAgents.length !== 1 ||
      live === undefined ||
      !(yield* isExactLinkedAgent(files, live, link))
    )
      return yield* failClosedLink(
        "validate live BTW agent",
        "herdr_btw_live_agent_ambiguous",
        "Another Pi is already using the linked side session",
      );
    yield* deliverAndFocus(link.agentName, live.pane_id, prompt);
    return { agentName: link.agentName, paneId: live.pane_id, mode: "focused" as const };
  });

  const openInner = Effect.fn("HerdrBtwService.open")(function* (prompt?: string) {
    const { sessionFile, sessionId } = yield* validateBtwInput(prompt, input, files);
    const restoration = linkStore.restore();
    if (HerdrBtwLinkRestoration.$is("malformed")(restoration))
      return yield* failClosedLink(
        "restore BTW link",
        "herdr_btw_link_malformed",
        "This session's side-session link is unreadable",
      );
    if (HerdrBtwLinkRestoration.$is("none")(restoration))
      return yield* openFreshCreate(prompt, sessionFile, sessionId);

    const link = restoration.link;
    if (
      !(yield* isValidBlankChild(link.childSessionPath, link.childSessionId)) ||
      !(yield* isDistinctChildSessionPath(files, link.childSessionPath, sessionFile))
    )
      return yield* failClosedLink(
        "validate linked child session",
        "herdr_btw_link_child_invalid",
        "The linked side session's file is missing or was replaced",
      );

    yield* ensureHerdrProtocol(herdr);
    const liveAgents = yield* Effect.filter(yield* herdr.inspectLiveAgents(), (agent) =>
      isLinkedAgentConflictCandidate(files, agent, link),
    );
    if (liveAgents.length > 0) return yield* focusLiveAgent(link, liveAgents, prompt);
    return yield* launch({ mode: "resume", link }, prompt, sessionFile, sessionId);
  });

  const openNewInner = Effect.fn("HerdrBtwService.openNew")(function* (prompt?: string) {
    const { sessionFile, sessionId } = yield* validateBtwInput(prompt, input, files);
    return yield* openFreshCreate(prompt, sessionFile, sessionId);
  });

  return {
    open: (prompt?: string) => gate.withPermit(openInner(prompt)),
    openNew: (prompt?: string) => gate.withPermit(openNewInner(prompt)),
  };
});

export class HerdrBtwService extends Context.Service<HerdrBtwService>()(
  "pi-herdr-btw/btw/service/HerdrBtwService",
  { make: makeHerdrBtwService },
) {
  static readonly layer = (input: HerdrBtwSessionInput) =>
    Layer.effect(this, makeHerdrBtwService(input));
}
