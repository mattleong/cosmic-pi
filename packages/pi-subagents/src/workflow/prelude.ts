/** Host bridge namespace installed by the sandbox boundary; members return promises. */
export const WORKFLOW_HOST_NAMESPACE = "__workflow";
/** Store key holding the script's verbatim `args`. */
export const WORKFLOW_ARGS_KEY = "__workflow_args";
/** One parallel()/pipeline() call accepts at most this many items. */
export const WORKFLOW_BATCH_LIMIT = 4_096;
/**
 * Phase titles the prelude forwards are cut to this length; the host clips them further for
 * display, so a long title never travels with every agent() call or makes it invalid.
 */
export const WORKFLOW_PRELUDE_PHASE_MAX_CHARS = 1_024;

/**
 * JavaScript evaluated inside the sandbox before the script body, on the script's first line so
 * reported line numbers match the script. It defines the Claude-Code-style workflow hooks as
 * non-writable globals; scripts may shadow them locally without a redeclaration error.
 *
 * Host members: `agent(prompt, options)` resolves to `{ result, outputTokens }` (result `null` when
 * the agent failed or was skipped) and rejects only for invalid calls; `event(event)` records phase
 * and log events; `load(reference)` returns a saved script `{ name, body }` for `workflow()`.
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
    if (!Array.isArray(items)) throw new TypeError(name + " expects an array");
    if (items.length > ${WORKFLOW_BATCH_LIMIT}) throw new RangeError(name + " accepts at most ${WORKFLOW_BATCH_LIMIT} items");
  };

  const bounded = (title) => title.slice(0, ${WORKFLOW_PRELUDE_PHASE_MAX_CHARS});

  const hooks = (scope) => {
    let current;
    const phase = (title) => {
      if (typeof title !== "string" || title.trim() === "") throw new TypeError("phase(title) expects a non-empty string");
      current = bounded(scope.prefix + title);
      emit({ type: "phase", title: current });
    };
    const log = (message) => emit({ type: "log", message: text(message) });
    const agent = (prompt, options) => {
      if (typeof prompt !== "string" || prompt.trim() === "")
        return Promise.reject(new TypeError("agent(prompt) expects a non-empty string prompt"));
      if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options)))
        return Promise.reject(new TypeError("agent(prompt, options) expects an options object"));
      const resolved = { ...options };
      if (typeof resolved.phase === "string") resolved.phase = bounded(scope.prefix + resolved.phase);
      else if ((resolved.phase === undefined || resolved.phase === null) && current !== undefined) resolved.phase = current;
      return host.agent(prompt, resolved).then((reply) => {
        spent += reply.outputTokens;
        return reply.result;
      });
    };
    return { phase, log, agent };
  };

  const parallel = (thunks) => {
    checkBatch("parallel()", thunks);
    return Promise.all(
      thunks.map((thunk, index) =>
        new Promise((resolve) => resolve(thunk())).then(undefined, (error) => {
          emit({ type: "log", level: "warning", message: "parallel() item " + index + " failed: " + describe(error) });
          return null;
        }),
      ),
    );
  };

  const pipeline = (items, ...stages) => {
    checkBatch("pipeline()", items);
    if (stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline() stages must be functions");
    return Promise.all(
      items.map((item, index) =>
        stages
          .reduce((previous, stage) => previous.then((value) => stage(value, item, index)), Promise.resolve(item))
          .then(undefined, (error) => {
            emit({ type: "log", level: "warning", message: "pipeline() item " + index + " failed: " + describe(error) });
            return null;
          }),
      ),
    );
  };

  const root = hooks({ prefix: "" });
  const workflow = (reference, childArgs) =>
    host.load(reference).then((loaded) => {
      const child = hooks({ prefix: "\\u25b8 " + loaded.name + " \\u00b7 " });
      const nested = () => Promise.reject(new Error("workflow() can only be nested one level deep"));
      const run = new AsyncFunction("args", "phase", "log", "agent", "workflow", loaded.body);
      return run(freeze(childArgs === undefined ? null : JSON.parse(JSON.stringify(childArgs))), child.phase, child.log, child.agent, nested);
    });

  define("args", freeze(load(${JSON.stringify(WORKFLOW_ARGS_KEY)}) ?? null));
  define("phase", root.phase);
  define("log", root.log);
  define("agent", root.agent);
  define("parallel", parallel);
  define("pipeline", pipeline);
  define("workflow", workflow);
  define("budget", Object.freeze({ total: null, spent: () => spent, remaining: () => Infinity }));
})();`;

/** The prelude as a single line, so it can share the script's first line. */
export const WORKFLOW_PRELUDE = preludeSource.replace(/\n\s*/g, " ");

/** Sandbox source: prelude plus the parsed script body, with script line numbers preserved. */
export const workflowSandboxSource = (body: string): string => `${WORKFLOW_PRELUDE}${body}`;
