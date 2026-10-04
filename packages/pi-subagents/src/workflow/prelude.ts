/** Host bridge namespace installed by the sandbox boundary; members return promises. */
export const WORKFLOW_HOST_NAMESPACE = "__workflow";
/** Store key holding the script's verbatim `args`. */
export const WORKFLOW_ARGS_KEY = "__workflow_args";
/** Store key holding the run's token budget, absent without one. */
export const WORKFLOW_BUDGET_KEY = "__workflow_budget";
/** One parallel()/pipeline() call accepts at most this many items. */
export const WORKFLOW_BATCH_LIMIT = 4_096;
/**
 * Phase titles the prelude forwards are cut to this length; the host clips them further for
 * display, so a long title never travels with every agent() call or makes it invalid.
 */
export const WORKFLOW_PRELUDE_PHASE_MAX_CHARS = 1_024;
/**
 * The `name` of the error an agent() call throws once the run's token budget is spent, so a
 * script's catch can tell it from other errors and the failure notice from other failures.
 */
export const WORKFLOW_BUDGET_ERROR = "WorkflowBudgetError";

/**
 * JavaScript evaluated inside the sandbox before the script body, on the script's first line so
 * reported line numbers match the script. It defines the Claude-Code-style workflow hooks as
 * non-writable globals; scripts may shadow them locally without a redeclaration error.
 *
 * Host members: `agent(prompt, options, workflow?)`, where a nested workflow's calls pass its name,
 * resolves to `{ result, outputTokens, refusal? }` (result
 * `null` when the agent failed, was stopped or was skipped; `outputTokens` what the call spent in
 * this run, 0 for a reused result; `refusal` the budget error's message when the budget was spent
 * before the agent started) and rejects only for invalid calls; `event(event)` records phase and
 * log events; `load(reference, args)` returns a saved script `{ name, body }` for `workflow()` and
 * rejects only for invalid calls, such as a reference that doesn't load or args that don't match
 * the script's `meta.args`.
 * `budget` is shared with nested workflows: `spent()` sums the replies so far, which is what the
 * host counted for settled agents, so it excludes agents still running.
 *
 * Errors from invalid agent(), parallel(), pipeline() and workflow() calls carry a private,
 * non-enumerable marker. parallel() and pipeline() rethrow a marked error, so an invalid call
 * fails the run even inside them. A budget error, named {@link WORKFLOW_BUDGET_ERROR}, carries a marker of its own:
 * agent() throws it like any error, so an uncaught one fails the run, but parallel() and
 * pipeline() resolve its item to null without a warning, since the run already warned once. Any other throw in an item or stage resolves that
 * item to null with a warning. The prelude is joined into one line, so it can't hold line comments.
 */
const preludeSource = `(() => {
  "use strict";
  const host = globalThis.${WORKFLOW_HOST_NAMESPACE};
  const NativeDate = Date;
  const AsyncFunction = (async () => {}).constructor;
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, enumerable: true });
  const freeze = (value) => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) freeze(value[key]);
    }
    return value;
  };
  const describe = (error) => (error instanceof Error ? error.name + ": " + error.message : String(error));
  const INVALID_CALL = Symbol("invalid workflow call");
  const invalid = (error) => {
    if (error !== null && typeof error === "object" && Object.isExtensible(error) && error[INVALID_CALL] !== true)
      Object.defineProperty(error, INVALID_CALL, { value: true });
    return error;
  };
  const isInvalid = (error) => error !== null && typeof error === "object" && error[INVALID_CALL] === true;
  const BUDGET_SPENT = Symbol("workflow budget spent");
  const isOverBudget = (error) => error !== null && typeof error === "object" && error[BUDGET_SPENT] === true;
  const isThenable = (value) => value !== null && typeof value === "object" && typeof value.then === "function";
  const typeName = (value) =>
    value === null || value === undefined ? String(value) : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : "a " + typeof value;
  const emit = (event) => { host.event(event).then(undefined, () => {}); };
  const text = (value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value));
  let spent = 0;

  const unavailable = (what) => () => {
    throw new Error(what + " is unavailable in workflows because it would make resume non-deterministic; pass values through args or vary prompts by index.");
  };
  Math.random = unavailable("Math.random()");
  function WorkflowDate(...values) {
    if (!new.target || values.length === 0) unavailable("The current date")();
    return new NativeDate(...values);
  }
  WorkflowDate.prototype = NativeDate.prototype;
  WorkflowDate.now = unavailable("Date.now()");
  WorkflowDate.parse = NativeDate.parse;
  WorkflowDate.UTC = NativeDate.UTC;
  define("Date", WorkflowDate);

  const checkBatch = (name, items) => {
    if (!Array.isArray(items)) throw invalid(new TypeError(name + " expects an array"));
    if (items.length > ${WORKFLOW_BATCH_LIMIT}) throw invalid(new RangeError(name + " accepts at most ${WORKFLOW_BATCH_LIMIT} items"));
  };

  const settle = (name, index, item) =>
    item.then(undefined, (error) => {
      if (isInvalid(error)) throw error;
      if (isOverBudget(error)) return null;
      emit({ type: "log", level: "warning", message: name + " item " + index + " failed: " + describe(error) });
      return null;
    });

  const bounded = (title) => title.slice(0, ${WORKFLOW_PRELUDE_PHASE_MAX_CHARS});

  const hooks = (scope) => {
    let current;
    const phase = (title) => {
      if (typeof title !== "string" || title.trim() === "") throw new TypeError("phase(title) expects a non-empty string");
      current = bounded(scope.prefix + title.trim());
      emit({ type: "phase", title: current });
    };
    const log = (message) => emit({ type: "log", message: text(message) });
    const agent = (prompt, options) => {
      if (typeof prompt !== "string" || prompt.trim() === "")
        return Promise.reject(invalid(new TypeError("agent(prompt) expects a non-empty string prompt")));
      if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options)))
        return Promise.reject(invalid(new TypeError("agent(prompt, options) expects an options object")));
      const resolved = { ...options };
      if (typeof resolved.phase === "string") resolved.phase = bounded(scope.prefix + resolved.phase.trim());
      else if ((resolved.phase === undefined || resolved.phase === null) && current !== undefined) resolved.phase = current;
      const site = new Error();
      const reply = scope.workflow === undefined ? host.agent(prompt, resolved) : host.agent(prompt, resolved, scope.workflow);
      return reply.then(
        (reply) => {
          spent += reply.outputTokens;
          if (typeof reply.refusal !== "string") return reply.result;
          site.name = ${JSON.stringify(WORKFLOW_BUDGET_ERROR)};
          site.message = reply.refusal;
          Object.defineProperty(site, BUDGET_SPENT, { value: true });
          throw site;
        },
        (error) => {
          site.message = error instanceof Error ? error.message : String(error);
          throw invalid(site);
        },
      );
    };
    return { phase, log, agent };
  };

  const parallel = (items) => {
    checkBatch("parallel()", items);
    const bad = items.findIndex((item) => typeof item !== "function" && !isThenable(item));
    if (bad !== -1)
      throw invalid(new TypeError("parallel() item " + bad + " is " + typeName(items[bad]) + ", not a function or a promise; pass () => agent(...)"));
    return Promise.all(
      items.map((item, index) =>
        settle("parallel()", index, typeof item === "function" ? new Promise((resolve) => resolve(item())) : Promise.resolve(item)),
      ),
    );
  };

  const pipeline = (items, ...stages) => {
    checkBatch("pipeline()", items);
    if (stages.some((stage) => typeof stage !== "function")) throw invalid(new TypeError("pipeline() stages must be functions"));
    return Promise.all(
      items.map((item, index) =>
        settle(
          "pipeline()",
          index,
          stages.reduce((previous, stage) => previous.then((value) => stage(value, item, index)), Promise.resolve(item)),
        ),
      ),
    );
  };

  const root = hooks({ prefix: "" });
  const workflow = (reference, childArgs) => {
    let passed;
    try {
      passed = childArgs === undefined ? null : JSON.parse(JSON.stringify(childArgs));
    } catch (error) {
      return Promise.reject(invalid(error));
    }
    const site = new Error();
    return host.load(reference, passed).then(
      (loaded) => {
        const child = hooks({ prefix: "\\u25b8 " + loaded.name + " \\u00b7 ", workflow: loaded.name });
        const nested = () => Promise.reject(invalid(new Error("workflow() can only be nested one level deep")));
        const run = new AsyncFunction("args", "phase", "log", "agent", "workflow", loaded.body);
        return run(freeze(passed), child.phase, child.log, child.agent, nested);
      },
      (error) => {
        site.message = error instanceof Error ? error.message : String(error);
        throw invalid(site);
      },
    );
  };

  define("args", freeze(load(${JSON.stringify(WORKFLOW_ARGS_KEY)}) ?? null));
  define("phase", root.phase);
  define("log", root.log);
  define("agent", root.agent);
  define("parallel", parallel);
  define("pipeline", pipeline);
  define("workflow", workflow);
  const total = load(${JSON.stringify(WORKFLOW_BUDGET_KEY)}) ?? null;
  define("budget", Object.freeze({ total, spent: () => spent, remaining: () => (total === null ? Infinity : Math.max(0, total - spent)) }));
})();`;

/** The prelude as a single line, so it can share the script's first line. */
export const WORKFLOW_PRELUDE = preludeSource.replace(/\n\s*/g, " ");

/** Sandbox source: prelude plus the parsed script body, with script line numbers preserved. */
export const workflowSandboxSource = (body: string): string => `${WORKFLOW_PRELUDE}${body}`;

/** pi-codemode's worker evaluates `(async (tools, console) => {<code>\n})`, so line 1 starts with it. */
const SANDBOX_WRAPPER_CHARS = "(async (tools, console) => {".length;
const STACK_FRAME = /^\s*at /u;
const NATIVE_FRAME = /\(native\)$/u;
const SANDBOX_POSITION = /^(\s*at .*?)\(?codemode\.js:(\d+):(\d+)\)?$/u;

/**
 * A failed script's stack in script terms, one unindented frame per line: sandbox positions become
 * `line L:C` of the script, frames inside the prelude and native frames are dropped, and so are
 * the leading message lines, which the failure line already shows. Undefined when no frame is left.
 */
export const workflowScriptStack = (stack: string): string | undefined => {
  const frames = stack.split("\n").flatMap((line): ReadonlyArray<string> => {
    if (!STACK_FRAME.test(line) || NATIVE_FRAME.test(line)) return [];
    const position = SANDBOX_POSITION.exec(line);
    if (!position) return [line.trim()];
    const [, head = "", lineText = "", columnText = ""] = position;
    const lineNumber = Number(lineText);
    // Line 1 holds the wrapper and the prelude ahead of the script's first line.
    const column =
      Number(columnText) - (lineNumber === 1 ? SANDBOX_WRAPPER_CHARS + WORKFLOW_PRELUDE.length : 0);
    return column > 0 ? [`${head.trim()} (line ${lineNumber}:${column})`] : [];
  });
  return frames.length > 0 ? frames.join("\n") : undefined;
};
