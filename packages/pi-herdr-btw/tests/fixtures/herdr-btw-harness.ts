import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  HerdrClient,
  type HerdrClientContract,
  type HerdrPane,
} from "../../src/boundary/herdr-client.ts";
import type {
  HerdrBtwLinkRecord,
  HerdrBtwLinkRecordResult,
  HerdrBtwLinkStore,
} from "../../src/boundary/host-link-store.ts";
import type {
  SessionFileIdentityComparator,
  SessionFileIdentityComparison,
  SessionHeaderProbe,
} from "../../src/boundary/session-file.ts";
import type { HerdrBtwLink, HerdrBtwLinkRestoration } from "../../src/btw/link.ts";
import { HerdrBtwService } from "../../src/btw/service.ts";
import { HerdrBtwError } from "../../src/btw/errors.ts";

export interface HerdrBtwClientCall {
  readonly operation: string;
  readonly input?: unknown;
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

export const operationInputs = <A>(
  calls: ReadonlyArray<HerdrBtwClientCall>,
  operation: string,
): A[] => {
  // SAFETY: Each fixture method records the semantic input paired with its fixed operation name.
  return calls.filter((call) => call.operation === operation).map((call) => call.input as A);
};

/** Advances through the bounded shell-readiness window before joining. */
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
/** A lexical alias of CHILD_FILE; comparators decide whether it names the same file. */
export const CHILD_ALIAS = "/sessions/aliases/../child.jsonl";
export const CWD = "/project";

/** Comparator for scenarios where one or two paths are lexically distinct aliases of one file. */
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

/** Superset of the option keys used by the btw-reuse and open-pane suites. */
export interface HerdrBtwFixtureOptions {
  readonly initialLinks?: ReadonlyArray<HerdrBtwLink>;
  readonly restoreOverride?: HerdrBtwLinkRestoration;
  readonly recordResult?: HerdrBtwLinkRecordResult;
  readonly liveAgents?: ReadonlyArray<HerdrPane>;
  readonly liveAgentSnapshots?: ReadonlyArray<ReadonlyArray<HerdrPane>>;
  readonly probes?: Readonly<Record<string, SessionHeaderProbe>>;
  readonly compareSessionFileIdentity?: SessionFileIdentityComparator;
  readonly failOperation?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly holdStart?: Deferred.Deferred<void>;
  readonly sessionId?: string;
  readonly createdChildId?: string;
  readonly createdChildFile?: string;
  readonly startedSession?: string;
  readonly startedSessionKind?: "id" | "path";
  readonly startedIdentityAvailable?: boolean;
  readonly startedTerminalId?: string;
  readonly width?: number;
  readonly protocol?: number;
  readonly integrationCurrent?: boolean;
  readonly layoutWorkspaceId?: string;
  readonly splitTabId?: string;
  readonly shellReadyAfter?: number;
  readonly shellReadiness?: ReadonlyArray<boolean>;
}

/**
 * Superset service fixture: per-scenario call recording and failure injection,
 * one client stub, a link store, and the four service seams with
 * makeService/open/openNew helpers.
 */
export const makeServiceFixture = (options: HerdrBtwFixtureOptions = {}) => {
  const calls: HerdrBtwClientCall[] = [];
  const runEffect = <A, Input>(
    operation: string,
    input: Input,
    effect: () => Effect.Effect<A, HerdrBtwError>,
  ): Effect.Effect<A, HerdrBtwError> =>
    Effect.suspend(() => {
      calls.push(input === undefined ? { operation } : { operation, input });
      return operation === options.failOperation
        ? Effect.fail(commandFailure(operation))
        : effect();
    });
  const run = <A, Input>(operation: string, input: Input, result: () => A) =>
    runEffect(operation, input, () => Effect.sync(result));
  const createdChildId = options.createdChildId ?? CHILD_ID;
  const createdChildFile = options.createdChildFile ?? CHILD_FILE;
  let snapshotReads = 0;
  let shellInspections = 0;
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
    tab_id: options.splitTabId ?? "w1:t1",
  };
  const startedAgentSnapshot = (agentName: string) => {
    const agent = {
      ...btwPane,
      terminal_id: options.startedTerminalId ?? btwPane.terminal_id,
      agent: "pi",
      name: agentName,
    };
    if (options.startedIdentityAvailable === false) return agent;
    return {
      ...agent,
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: options.startedSessionKind ?? "path",
        value: options.startedSession ?? createdChildFile,
      },
    };
  };

  const client = HerdrClient.of({
    inspectProtocol: () => run("inspect protocol", undefined, () => options.protocol ?? 20),
    inspectPiIntegration: () =>
      run("inspect Pi integration", undefined, () => options.integrationCurrent ?? true),
    inspectLiveAgents: () =>
      run(
        "inspect live agents",
        undefined,
        () =>
          options.liveAgentSnapshots?.[snapshotReads++] ??
          options.liveAgents ??
          (startedAgentName === undefined ? [] : [startedAgentSnapshot(startedAgentName)]),
      ),
    resolveCallingPane: () => run("resolve calling pane", undefined, () => parentPane),
    inspectPaneLayout: (paneId) =>
      run("inspect calling pane layout", { paneId }, () => ({
        workspace_id: options.layoutWorkspaceId ?? "w1",
        tab_id: "w1:t1",
        area: { width: options.width ?? 160, height: 40 },
      })),
    splitPane: (input) => run("split BTW pane", input, () => btwPane),
    inspectPaneProcessInfo: (paneId) =>
      run("inspect BTW pane shell", { paneId }, () => {
        shellInspections += 1;
        const ready =
          options.shellReadiness?.[shellInspections - 1] ??
          shellInspections >= (options.shellReadyAfter ?? 1);
        return ready
          ? {
              pane_id: btwPane.pane_id,
              shell_pid: 4242,
              foreground_process_group_id: 4242,
              foreground_processes: [{ pid: 4242, name: "zsh" }],
            }
          : { pane_id: btwPane.pane_id };
      }),
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
  const linkStore: HerdrBtwLinkStore = {
    restore: () => {
      restoreCount += 1;
      if (options.restoreOverride) return options.restoreOverride;
      const link = recordedLinks.at(-1);
      return link === undefined ? { _tag: "none" } : { _tag: "restored", link };
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
        return { _tag: "valid", header: { id: options.sessionId ?? SESSION_ID } };
      if (path === CHILD_FILE) return { _tag: "valid", header: { id: CHILD_ID } };
      return path === createdChildFile
        ? { _tag: "valid", header: { id: createdChildId } }
        : { _tag: "invalid" };
    },
    compareSessionFileIdentity:
      options.compareSessionFileIdentity ??
      ((leftPath: string, rightPath: string) =>
        leftPath === rightPath ? ("same" as const) : ("distinct" as const)),
    createChildSessionId: () => createdChildId,
    createBlankChildSessionFile: () =>
      Effect.succeed({ _tag: "created" as const, path: createdChildFile }),
  };
  const makeService = HerdrBtwService.make({ ...input, linkStore }, serviceOptions).pipe(
    Effect.provideService(HerdrClient, client),
  );
  const open = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.open(prompt));
  const openNew = (prompt?: string | undefined) =>
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
