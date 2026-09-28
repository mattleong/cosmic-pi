import { createEventBus, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import type { CodeModeResult } from "../../src/engine/diagnostic.ts";
import { executeProgram } from "../../src/engine/execute.ts";
import type { CodeModeConfig } from "../../src/config/schema.ts";
import {
  makeCodeModeToolExecute,
  type CodeModeExecutionEnvironment,
} from "../../src/tools/execution.ts";
import type { CodeModeToolDetails } from "../../src/tools/format.ts";
import type { CodeModeInput } from "../../src/tools/result-read.ts";
import { makeFailureDetailsRetention } from "../../src/tools/retention.ts";
import { codeModeStateFixture } from "./host.ts";
import { TEST_SESSION_ID } from "./providers.ts";
import { nestedToolDefinitionsFixture } from "./tools.ts";

export interface ExecuteHarnessOptions extends Partial<
  Omit<CodeModeExecutionEnvironment, "retainFailureDetails" | "cwd">
> {
  /** Overrides on the default state; unused when `getState` is given. */
  readonly config?: Partial<CodeModeConfig>;
  /** The host context's cwd. Omitted, `ctx.cwd` is undefined, as with a missing UI context. */
  readonly cwd?: string;
  /** The directory programs run in; defaults to the test process's directory. */
  readonly programCwd?: string;
  /**
   * Runner behind the default signal-forwarding `runInSession`. Pass the test context's runner
   * where TestClock must drive session work; unused when `runInSession` is given.
   */
  readonly runPromise?: typeof Effect.runPromise;
  /** `true` retains thrown-failure details into the harness's `retention`. */
  readonly retainFailureDetails?: CodeModeExecutionEnvironment["retainFailureDetails"] | true;
}

export interface CallOptions {
  readonly id?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onUpdate?: AgentToolUpdateCallback<CodeModeToolDetails> | undefined;
}

/**
 * One real `makeCodeModeToolExecute` over real program processes. Defaults: an available default state,
 * no nested definitions (every Pi tool reports as unavailable), a fresh event bus, the shared test
 * session, and no retained-results store or failure retention unless passed.
 */
export const executeHarness = (options: ExecuteHarnessOptions = {}) => {
  const state = codeModeStateFixture(options.config);
  const runPromise = options.runPromise ?? Effect.runPromise;
  const executeCodeMode = options.executeCodeMode ?? executeProgram;
  let latest: CodeModeResult | undefined;
  const retention = makeFailureDetailsRetention();
  const retain =
    options.retainFailureDetails === true ? retention.retain : options.retainFailureDetails;
  const execute = makeCodeModeToolExecute({
    isCurrent: options.isCurrent ?? (() => true),
    getState: options.getState ?? (() => state),
    runInSession:
      options.runInSession ??
      ((effect, signal) => runPromise(effect, signal ? { signal } : undefined)),
    cwd: options.programCwd ?? process.cwd(),
    definitions: options.definitions ?? nestedToolDefinitionsFixture({}),
    events: options.events ?? createEventBus(),
    // An explicit `sessionId: undefined` must still reach the fail-closed path.
    sessionId: "sessionId" in options ? options.sessionId : TEST_SESSION_ID,
    // Observes guest values independently of host safety framing.
    executeCodeMode: (runtime) =>
      executeCodeMode({
        ...runtime,
        onResult: (result) => {
          latest = result;
          runtime.onResult?.(result);
        },
      }),
    ...(options.results !== undefined && { results: options.results }),
    ...(retain !== undefined && { retainFailureDetails: retain }),
  });
  const ctx = extensionContextFixture(options.cwd === undefined ? {} : { cwd: options.cwd });
  const call = (params: CodeModeInput, { id = "call", signal, onUpdate }: CallOptions = {}) =>
    execute(id, params, signal, onUpdate, ctx);
  return {
    execute,
    call,
    run: (code: string, callOptions?: CallOptions) => call({ code }, callOptions),
    retention,
    /** The last guest value execution returned, before host framing. */
    guestValue: () => (latest?.ok ? latest.value : undefined),
  };
};

/** Model-visible text: text blocks only, newline-joined. */
export const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
