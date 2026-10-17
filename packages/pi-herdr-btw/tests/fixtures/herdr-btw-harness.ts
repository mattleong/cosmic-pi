import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  HerdrClient,
  type HerdrClientContract,
  type HerdrPane,
  type HerdrSplitPaneInput,
  type HerdrStartSideSessionInput,
} from "../../src/boundary/herdr-client.ts";
import {
  HerdrBtwLinkStore,
  type HerdrBtwLinkRecord,
  type HerdrBtwLinkRecordResult,
  type HerdrBtwLinkStoreContract,
} from "../../src/boundary/host-link-store.ts";
import {
  BlankChildSessionFileResult,
  SessionHeaderProbe,
  type SessionFileIdentityComparator,
  type SessionFileIdentityComparison,
} from "../../src/boundary/session-file.ts";
import { HerdrBtwLinkRestoration, type HerdrBtwLink } from "../../src/btw/link.ts";
import { HerdrBtwService } from "../../src/btw/service.ts";
import { HerdrBtwError } from "../../src/btw/errors.ts";

type HerdrBtwCallInput =
  | HerdrSplitPaneInput
  | HerdrStartSideSessionInput
  | { readonly paneId: string }
  | { readonly agentName: string; readonly prompt?: string };

interface HerdrBtwClientCall {
  readonly operation: string;
  readonly input?: HerdrBtwCallInput;
}

const MUTATING_OPERATIONS = new Set([
  "split BTW pane",
  "start side-session Pi",
  "prompt side-session Pi",
  "focus side-session Pi",
]);

const commandFailure = (operation: string): HerdrBtwError =>
  new HerdrBtwError({
    operation,
    code: `fixture_${operation.toLowerCase().replaceAll(" ", "_")}`,
    message: `Fixture failure during ${operation}.`,
    outcome: MUTATING_OPERATIONS.has(operation) ? "uncertain" : "confirmed",
  });

export const operationNames = (calls: ReadonlyArray<HerdrBtwClientCall>): string[] =>
  calls.map((call) => call.operation);

export const operationCount = (calls: ReadonlyArray<HerdrBtwClientCall>, operation: string) =>
  calls.filter((call) => call.operation === operation).length;

export const operationInputs = (calls: ReadonlyArray<HerdrBtwClientCall>, operation: string) =>
  calls.flatMap((call) => (call.operation === operation ? [call.input] : []));

export const withShellReadiness = <A, E>(workflow: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* workflow.pipe(Effect.forkScoped({ startImmediately: true }));
    for (let step = 0; step < 32; step += 1) yield* TestClock.adjust("200 millis");
    return yield* Fiber.join(fiber);
  });

export const SESSION_FILE = "/sessions/parent.jsonl";
export const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
export const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
export const CHILD_FILE = "/sessions/child.jsonl";
export const CWD = "/project";

export const aliasIdentity =
  (
    aliasPaths: readonly string[],
    aliasResult: SessionFileIdentityComparison = "same",
  ): SessionFileIdentityComparator =>
  (leftPath, rightPath) =>
    [leftPath, rightPath].every((path) => aliasPaths.includes(path))
      ? aliasResult
      : leftPath === rightPath
        ? "same"
        : "distinct";

export interface HerdrBtwFixtureOptions {
  readonly initialLinks?: ReadonlyArray<HerdrBtwLink>;
  readonly recordResult?: HerdrBtwLinkRecordResult;
  readonly liveAgents?: ReadonlyArray<HerdrPane>;
  readonly liveAgentSnapshots?: ReadonlyArray<ReadonlyArray<HerdrPane>>;
  readonly onLiveAgentSnapshot?: (index: number) => void;
  readonly probes?: Readonly<Record<string, SessionHeaderProbe>>;
  readonly compareSessionFileIdentity?: SessionFileIdentityComparator;
  readonly failOperation?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly holdStart?: Deferred.Deferred<void>;
  readonly sessionId?: string;
  readonly createdChildId?: string;
  readonly createdChildFile?: string;
  readonly startedSession?: string;
  readonly protocol?: number;
}

export const makeServiceFixture = (options: HerdrBtwFixtureOptions = {}) => {
  const calls: HerdrBtwClientCall[] = [];
  const runEffect = <A>(
    operation: string,
    input: HerdrBtwCallInput | undefined,
    effect: () => Effect.Effect<A, HerdrBtwError>,
  ): Effect.Effect<A, HerdrBtwError> =>
    Effect.suspend(() => {
      calls.push(input === undefined ? { operation } : { operation, input });
      return operation === options.failOperation
        ? Effect.fail(commandFailure(operation))
        : effect();
    });
  const run = <A>(operation: string, input: HerdrBtwCallInput | undefined, result: () => A) =>
    runEffect(operation, input, () => Effect.sync(result));
  const createdChildId = options.createdChildId ?? CHILD_ID;
  const createdChildFile = options.createdChildFile ?? CHILD_FILE;
  let snapshotReads = 0;
  let startedAgentName: string | undefined;
  const parentPane = {
    pane_id: "w1:p1",
    terminal_id: "term-parent",
    workspace_id: "w1",
    tab_id: "w1:t1",
  };
  const btwPane = {
    pane_id: "w1:p2",
    terminal_id: "term-btw",
    workspace_id: "w1",
    tab_id: "w1:t1",
  };
  const startedAgentSnapshot = (agentName: string) => ({
    ...btwPane,
    agent: "pi",
    name: agentName,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path" as const,
      value: options.startedSession ?? createdChildFile,
    },
  });

  const client = HerdrClient.of({
    inspectProtocol: () => run("inspect protocol", undefined, () => options.protocol ?? 20),
    inspectPiIntegration: () => run("inspect Pi integration", undefined, () => true),
    inspectLiveAgents: () =>
      run("inspect live agents", undefined, () => {
        const index = snapshotReads++;
        options.onLiveAgentSnapshot?.(index);
        return (
          options.liveAgentSnapshots?.[index] ??
          options.liveAgents ??
          (startedAgentName === undefined ? [] : [startedAgentSnapshot(startedAgentName)])
        );
      }),
    resolveCallingPane: () => run("resolve calling pane", undefined, () => parentPane),
    inspectPaneLayout: (paneId) =>
      run("inspect calling pane layout", { paneId }, () => ({
        workspace_id: "w1",
        tab_id: "w1:t1",
        area: { width: 160, height: 40 },
      })),
    splitPane: (input) => run("split BTW pane", input, () => btwPane),
    inspectPaneProcessInfo: (paneId) =>
      run("inspect BTW pane shell", { paneId }, () => ({
        pane_id: btwPane.pane_id,
        shell_pid: 4242,
        foreground_process_group_id: 4242,
        foreground_processes: [{ pid: 4242, name: "zsh" }],
      })),
    startSideSessionPi: (input) =>
      runEffect("start side-session Pi", input, () => {
        const started = Effect.sync(() => {
          startedAgentName = input.agentName;
          return startedAgentSnapshot(input.agentName);
        });
        return options.holdStart === undefined
          ? started
          : Deferred.await(options.holdStart).pipe(Effect.andThen(started));
      }),
    promptSideSessionPi: (agentName, prompt) =>
      run("prompt side-session Pi", { agentName, prompt }, () => undefined),
    focusSideSessionPi: (agentName) => run("focus side-session Pi", { agentName }, () => undefined),
  } satisfies HerdrClientContract);

  const input = {
    environment: options.environment ?? {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_WORKSPACE_ID: "w1",
    },
    cwd: CWD,
    sessionFile: SESSION_FILE,
    sessionId: options.sessionId ?? SESSION_ID,
    sessionDir: "/sessions",
  };
  const recordedLinks: HerdrBtwLink[] = [...(options.initialLinks ?? [])];
  const recordAttempts: HerdrBtwLinkRecord[] = [];
  let restoreCount = 0;
  const linkStore: HerdrBtwLinkStoreContract = {
    restore: () => {
      restoreCount += 1;
      const link = recordedLinks.at(-1);
      return link === undefined
        ? HerdrBtwLinkRestoration.none()
        : HerdrBtwLinkRestoration.restored({ link });
    },
    record: (link) => {
      recordAttempts.push(link);
      const result = options.recordResult ?? "recorded";
      if (result !== "recorded") return result;
      recordedLinks.push({
        version: 1,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        ...link,
      });
      return result;
    },
  };
  const serviceOptions = {
    probeSessionHeader: (path: string): SessionHeaderProbe => {
      const override = options.probes?.[path];
      if (override) return override;
      if (path === SESSION_FILE)
        return SessionHeaderProbe.valid({ header: { id: options.sessionId ?? SESSION_ID } });
      if (path === CHILD_FILE) return SessionHeaderProbe.valid({ header: { id: CHILD_ID } });
      return path === createdChildFile
        ? SessionHeaderProbe.valid({ header: { id: createdChildId } })
        : SessionHeaderProbe.invalid();
    },
    compareSessionFileIdentity:
      options.compareSessionFileIdentity ??
      ((leftPath: string, rightPath: string) =>
        leftPath === rightPath ? ("same" as const) : ("distinct" as const)),
    createChildSessionId: () => createdChildId,
    createBlankChildSessionFile: () =>
      Effect.succeed(BlankChildSessionFileResult.created({ path: createdChildFile })),
  };
  const makeService = HerdrBtwService.make(input, serviceOptions).pipe(
    Effect.provideService(HerdrClient, client),
    Effect.provideService(HerdrBtwLinkStore, linkStore),
  );
  const open = (prompt?: string) => Effect.flatMap(makeService, (service) => service.open(prompt));
  const openNew = (prompt?: string) =>
    Effect.flatMap(makeService, (service) => service.openNew(prompt));

  return {
    calls,
    linkStore,
    makeService,
    open,
    openNew,
    recordAttempts,
    recordedLinks,
    restoreCount: () => restoreCount,
  };
};
