import { yieldDelegated, yieldGenerator } from "./generators.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { RuntimeFailure } from "../failure.js";
import { TOOL_CALL_CONCURRENCY } from "../stdlib/promise.js";
import { errorConstructors } from "../stdlib/value.js";
import { ToolReference, ToolRuntime } from "../tool-runtime.js";
import {
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import * as bindingsOps from "./bindings.js";
import * as builtinsOps from "./builtins.js";
import * as callableOps from "./callable.js";
import { ExecutionDeadline } from "./confinement.js";
import * as consoleOps from "./console.js";
import * as constructorsOps from "./constructors.js";
import * as executionOps from "./execution.js";
import * as expressionsOps from "./expressions.js";
import { GuestTurns } from "./guest-turns.js";
import * as iterationOps from "./iteration.js";
import * as membersOps from "./members.js";
import {
  asNode,
  type AstNode,
  type GuestPropertyKey,
  InterpreterRuntimeError,
  type AstPropertyValue,
  type Binding,
  CodeModeFunction,
  CoercionFunction,
  ComputedValue,
  ErrorConstructorReference,
  getArray,
  getNode,
  getString,
  GlobalMethodReference,
  GlobalNamespace,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  IntrinsicReference,
  type MemberReference,
  OptionalShortCircuit,
  type ProgramNode,
  PromiseMethodReference,
  PromiseNamespace,
  type StatementResult,
  UriFunction,
} from "./model.js";
import * as promisesOps from "./promises.js";
import * as scopeOps from "./scope.js";
import * as statementsOps from "./statements.js";

// Every identifier a parameter pattern binds, used to seed TDZ slots before defaults run.
export const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<string> => {
  switch (pattern.type) {
    case "Identifier":
      out.push(getString(pattern, "name"));
      break;
    case "AssignmentPattern":
      collectPatternNames(getNode(pattern, "left"), out);
      break;
    case "RestElement":
      collectPatternNames(getNode(pattern, "argument"), out);
      break;
    case "ArrayPattern":
      for (const element of getArray(pattern, "elements")) {
        if (element !== null) collectPatternNames(asNode(element, "elements"), out);
      }
      break;
    case "ObjectPattern":
      for (const property of getArray(pattern, "properties")) {
        const prop = asNode(property, "properties");
        collectPatternNames(
          prop.type === "RestElement" ? getNode(prop, "argument") : getNode(prop, "value"),
          out,
        );
      }
      break;
  }
  return out;
};

export type PromiseOwners = ReadonlyArray<Set<SandboxPromise>>;

export class Interpreter<R> {
  scopes: Array<Map<string, Binding>>;
  functionScope: Map<string, Binding> | undefined;
  generatorAsync = false;
  awaitIteratorPromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* this.releaseTurn();
      if (this.firstBoundary !== undefined) {
        const boundary = this.firstBoundary;
        this.firstBoundary = undefined;
        yield* Deferred.succeed(boundary, undefined);
      }
      const settled = yield* Effect.exit(this.settlePromise(promise, node));
      yield* this.execution.turns.take(this.turn);
      return yield* settled;
    });
  }
  yieldValue(
    value: InterpreterValue,
    node: AstNode,
    delegate: boolean,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    return delegate
      ? yieldDelegated(this, value, node, this.generatorAsync)
      : yieldGenerator(this, value, node);
  }
  generatorYield:
    | ((value: InterpreterValue) => Effect.Effect<InterpreterValue, RuntimeFailure, R>)
    | undefined;
  variableScope(): Map<string, Binding> {
    const scope = this.functionScope ?? this.scopes[1];
    if (scope === undefined) throw new InterpreterRuntimeError("Missing function environment.");
    return scope;
  }
  readonly invokeTool: (
    path: ReadonlyArray<string>,
    args: InterpreterArray,
    lifecycleId?: number,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  readonly onToolCallLifecycle:
    | ((event: ToolRuntime.ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  readonly execution: {
    nextToolCallLifecycleId: number;
    activePromises: number;
    scope: Scope.Scope;
    turns: GuestTurns;
    interrupting: Set<SandboxPromise>;
  };
  owners: PromiseOwners;
  turn: { held: boolean };
  firstBoundary: Deferred.Deferred<void> | undefined;
  // Enumerable namespace/tool names at a node of the host tool tree, threaded from
  // ToolRuntime.make like invokeTool: the interpreter never holds the tree itself.
  readonly toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
  readonly logs: Array<string>;
  // Shared wall-clock deadline (confinement): checked between interpreter steps so an
  // overrun inside a synchronous native operation is normalized to TimeoutExceeded as soon
  // as control returns to the interpreter, instead of racing the event-loop-starved timer.
  readonly deadline: ExecutionDeadline;
  lastValue: InterpreterValue;
  // Caps how many eagerly forked tool calls run at once (the parallel-call concurrency cap).
  readonly callPermits: Semaphore.Semaphore;
  // Fiber-backed promises whose settlement no program construct has observed yet. Successful
  // program completion drains these (like a runtime waiting on in-flight work at exit) and
  // surfaces a never-awaited failure as an unhandled-rejection diagnostic.
  readonly pendingSettlements = new Set<SandboxPromise>();

  private readonly executionHost: executionOps.ExecutionHost<R> = ((owner: Interpreter<R>) => ({
    currentScope: this.currentScope.bind(this),
    get functionScope() {
      return owner.functionScope;
    },
    set functionScope(value) {
      owner.functionScope = value;
    },
    get callPermits() {
      return owner.callPermits;
    },
    get deadline() {
      return owner.deadline;
    },
    drainPendingSettlements: this.drainPendingSettlements.bind(this),
    evaluateStatement: this.evaluateStatement.bind(this),
    get execution() {
      return owner.execution;
    },
    hoistFunctions: this.hoistFunctions.bind(this),
    interruptPromise: this.interruptPromise.bind(this),
    get invokeTool() {
      return owner.invokeTool;
    },
    get lastValue() {
      return owner.lastValue;
    },
    set lastValue(value) {
      owner.lastValue = value;
    },
    observePromise: this.observePromise.bind(this),
    get onToolCallLifecycle() {
      return owner.onToolCallLifecycle;
    },
    get owners() {
      return owner.owners;
    },
    set owners(value) {
      owner.owners = value;
    },
    get pendingSettlements() {
      return owner.pendingSettlements;
    },
    popScope: this.popScope.bind(this),
    promiseSettlement: this.promiseSettlement.bind(this),
    pushScope: this.pushScope.bind(this),
    releaseTurn: this.releaseTurn.bind(this),
    settlePromise: this.settlePromise.bind(this),
    startPromise: this.startPromise.bind(this),
    get turn() {
      return owner.turn;
    },
    set turn(value) {
      owner.turn = value;
    },
    unwrapPromiseExit: this.unwrapPromiseExit.bind(this),
  }))(this);

  private readonly statementsHost: statementsOps.StatementsHost<R> = ((owner: Interpreter<R>) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    invokeCallable: this.invokeCallable.bind(this),
    settlePromise: this.settlePromise.bind(this),
    createFunction: this.createFunction.bind(this),
    currentScope: this.currentScope.bind(this),
    get deadline() {
      return owner.deadline;
    },
    declare: this.declare.bind(this),
    declarePattern: this.declarePattern.bind(this),
    enumerableKeys: this.enumerableKeys.bind(this),
    evaluateBlock: this.evaluateBlock.bind(this),
    evaluateBreakStatement: this.evaluateBreakStatement.bind(this),
    evaluateContinueStatement: this.evaluateContinueStatement.bind(this),
    evaluateDoWhileStatement: this.evaluateDoWhileStatement.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
    evaluateForInStatement: this.evaluateForInStatement.bind(this),
    evaluateForOfStatement: this.evaluateForOfStatement.bind(this),
    evaluateForStatement: this.evaluateForStatement.bind(this),
    evaluateIfStatement: this.evaluateIfStatement.bind(this),
    evaluateStatement: this.evaluateStatement.bind(this),
    evaluateSwitchStatement: this.evaluateSwitchStatement.bind(this),
    evaluateThrowStatement: this.evaluateThrowStatement.bind(this),
    evaluateTryStatement: this.evaluateTryStatement.bind(this),
    evaluateVariableDeclaration: this.evaluateVariableDeclaration.bind(this),
    evaluateWhileStatement: this.evaluateWhileStatement.bind(this),
    hoistFunctions: this.hoistFunctions.bind(this),
    get lastValue() {
      return owner.lastValue;
    },
    set lastValue(value) {
      owner.lastValue = value;
    },
    popScope: this.popScope.bind(this),
    pushScope: this.pushScope.bind(this),
    get scopes() {
      return owner.scopes;
    },
    set scopes(value) {
      owner.scopes = value;
    },
    setIdentifierValue: this.setIdentifierValue.bind(this),
    get toolKeys() {
      return owner.toolKeys;
    },
  }))(this);

  private readonly bindingsHost: bindingsOps.BindingsHost<R> = ((owner: Interpreter<R>) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    get deadline() {
      return owner.deadline;
    },
    invokeCallable: this.invokeCallable.bind(this),
    settlePromise: this.settlePromise.bind(this),
    variableScope: this.variableScope.bind(this),
    resolveBinding: this.resolveBinding.bind(this),
    declare: this.declare.bind(this),
    declarePattern: this.declarePattern.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
  }))(this);

  private readonly expressionsHost: expressionsOps.ExpressionsHost<R> = ((
    owner: Interpreter<R>,
  ) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    yieldValue: this.yieldValue.bind(this),
    invokeCallable: this.invokeCallable.bind(this),
    applyBinaryOperator: this.applyBinaryOperator.bind(this),
    applyCompoundAssignment: this.applyCompoundAssignment.bind(this),
    constructRegExp: this.constructRegExp.bind(this),
    createFunction: this.createFunction.bind(this),
    get deadline() {
      return owner.deadline;
    },
    evaluateArrayExpression: this.evaluateArrayExpression.bind(this),
    evaluateAssignmentExpression: this.evaluateAssignmentExpression.bind(this),
    evaluateBinaryExpression: this.evaluateBinaryExpression.bind(this),
    evaluateCallExpression: this.evaluateCallExpression.bind(this),
    evaluateConditionalExpression: this.evaluateConditionalExpression.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
    evaluateLogicalAssignment: this.evaluateLogicalAssignment.bind(this),
    evaluateLogicalExpression: this.evaluateLogicalExpression.bind(this),
    evaluateNewExpression: this.evaluateNewExpression.bind(this),
    evaluateObjectExpression: this.evaluateObjectExpression.bind(this),
    evaluateTemplateLiteral: this.evaluateTemplateLiteral.bind(this),
    evaluateUnaryExpression: this.evaluateUnaryExpression.bind(this),
    evaluateUpdateExpression: this.evaluateUpdateExpression.bind(this),
    get execution() {
      return owner.execution;
    },
    get firstBoundary() {
      return owner.firstBoundary;
    },
    set firstBoundary(value) {
      owner.firstBoundary = value;
    },
    getIdentifierValue: this.getIdentifierValue.bind(this),
    modifyMember: this.modifyMember.bind(this),
    readMember: this.readMember.bind(this),
    releaseTurn: this.releaseTurn.bind(this),
    resolveBinding: this.resolveBinding.bind(this),
    setIdentifierValue: this.setIdentifierValue.bind(this),
    settlePromise: this.settlePromise.bind(this),
    toPropertyKey: this.toPropertyKey.bind(this),
    get turn() {
      return owner.turn;
    },
    set turn(value) {
      owner.turn = value;
    },
    writeMember: this.writeMember.bind(this),
  }))(this);

  private readonly callableHost: callableOps.CallableHost<R> = ((owner: Interpreter<R>) => ({
    get functionScope() {
      return owner.functionScope;
    },
    set functionScope(value) {
      owner.functionScope = value;
    },
    settlePromise: this.settlePromise.bind(this),
    rejectCircularInsertion: this.rejectCircularInsertion.bind(this),
    assignToReference: this.assignToReference.bind(this),
    constructAggregateError: this.constructAggregateError.bind(this),
    createToolCallPromise: this.createToolCallPromise.bind(this),
    currentScope: this.currentScope.bind(this),
    get deadline() {
      return owner.deadline;
    },
    declarePattern: this.declarePattern.bind(this),
    evaluateCallArguments: this.evaluateCallArguments.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
    evaluateStatement: this.evaluateStatement.bind(this),
    fork: () => this.fork(),
    invokeArrayFrom: this.invokeArrayFrom.bind(this),
    invokeArrayMethod: this.invokeArrayMethod.bind(this),
    invokeCallable: this.invokeCallable.bind(this),
    invokeConsole: this.invokeConsole.bind(this),
    invokeFunction: this.invokeFunction.bind(this),
    invokeIntrinsic: this.invokeIntrinsic.bind(this),
    invokeMapMethod: this.invokeMapMethod.bind(this),
    invokeObjectMethodOnTools: this.invokeObjectMethodOnTools.bind(this),
    invokePromiseChain: this.invokePromiseChain.bind(this),
    invokePromiseMethod: this.invokePromiseMethod.bind(this),
    invokeSetMethod: this.invokeSetMethod.bind(this),
    invokeStringReplacer: this.invokeStringReplacer.bind(this),
    get invokeTool() {
      return owner.invokeTool;
    },
    invokeURLSearchParamsMethod: this.invokeURLSearchParamsMethod.bind(this),
    get logs() {
      return owner.logs;
    },
    get onToolCallLifecycle() {
      return owner.onToolCallLifecycle;
    },
    get owners() {
      return owner.owners;
    },
    set owners(value) {
      owner.owners = value;
    },
    get scopes() {
      return owner.scopes;
    },
    set scopes(value) {
      owner.scopes = value;
    },
    startPromise: this.startPromise.bind(this),
    get toolKeys() {
      return owner.toolKeys;
    },
  }))(this);

  private readonly promisesHost: promisesOps.PromisesHost<R> = ((owner: Interpreter<R>) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    invokeCallable: this.invokeCallable.bind(this),
    chainReaction: this.chainReaction.bind(this),
    constructAggregateError: this.constructAggregateError.bind(this),
    get deadline() {
      return owner.deadline;
    },
    evaluatePromiseMethod: this.evaluatePromiseMethod.bind(this),
    get execution() {
      return owner.execution;
    },
    interruptPromise: this.interruptPromise.bind(this),
    get invokeTool() {
      return owner.invokeTool;
    },
    get logs() {
      return owner.logs;
    },
    observePromise: this.observePromise.bind(this),
    get onToolCallLifecycle() {
      return owner.onToolCallLifecycle;
    },
    get owners() {
      return owner.owners;
    },
    set owners(value) {
      owner.owners = value;
    },
    get pendingSettlements() {
      return owner.pendingSettlements;
    },
    promiseReaction: this.promiseReaction.bind(this),
    settlePromise: this.settlePromise.bind(this),
    startPromise: this.startPromise.bind(this),
    get toolKeys() {
      return owner.toolKeys;
    },
    unwrapPromiseExit: this.unwrapPromiseExit.bind(this),
    fork: () => this.fork(),
  }))(this);

  private readonly builtinsHost: builtinsOps.BuiltinsHost<R> = ((owner: Interpreter<R>) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    settlePromise: this.settlePromise.bind(this),
    applyCollectionCallback: this.applyCollectionCallback.bind(this),
    get deadline() {
      return owner.deadline;
    },
    invokeCallable: this.invokeCallable.bind(this),
    rejectCircularInsertion: this.rejectCircularInsertion.bind(this),
    sortArray: this.sortArray.bind(this),
  }))(this);

  private readonly iterationHost: iterationOps.IterationHost<R> = ((owner: Interpreter<R>) => ({
    applyCollectionCallback: this.applyCollectionCallback.bind(this),
    get deadline() {
      return owner.deadline;
    },
    invokeCallable: this.invokeCallable.bind(this),
  }))(this);

  private readonly membersHost: membersOps.MembersHost<R> = ((_owner: Interpreter<R>) => ({
    assignToReference: this.assignToReference.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
    getMemberReference: this.getMemberReference.bind(this),
    modifyMember: this.modifyMember.bind(this),
    rejectCircularInsertion: this.rejectCircularInsertion.bind(this),
    toPropertyKey: this.toPropertyKey.bind(this),
  }))(this);

  private readonly scopeHost: scopeOps.ScopeHost<R> = ((owner: Interpreter<R>) => ({
    currentScope: this.currentScope.bind(this),
    resolveBinding: this.resolveBinding.bind(this),
    get scopes() {
      return owner.scopes;
    },
    set scopes(value) {
      owner.scopes = value;
    },
  }))(this);

  private readonly constructorsHost: constructorsOps.ConstructorsHost<R> = ((
    owner: Interpreter<R>,
  ) => ({
    awaitIteratorPromise: this.awaitIteratorPromise.bind(this),
    get deadline() {
      return owner.deadline;
    },
    invokeCallable: this.invokeCallable.bind(this),
    settlePromise: this.settlePromise.bind(this),
    constructAggregateError: this.constructAggregateError.bind(this),
    evaluateCallArguments: this.evaluateCallArguments.bind(this),
    evaluateExpression: this.evaluateExpression.bind(this),
    constructDate: this.constructDate.bind(this),
    constructRegExp: this.constructRegExp.bind(this),
    constructMap: this.constructMap.bind(this),
    constructSet: this.constructSet.bind(this),
    constructURL: this.constructURL.bind(this),
    constructURLSearchParams: this.constructURLSearchParams.bind(this),
  }))(this);
  private readonly consoleHost: consoleOps.ConsoleHost<R> = ((owner: Interpreter<R>) => ({
    enumerableKeys: this.enumerableKeys.bind(this),
    get logs() {
      return owner.logs;
    },
    formatConsoleMessage: this.formatConsoleMessage.bind(this),
    formatConsoleArgument: this.formatConsoleArgument.bind(this),
    formatConsoleTable: this.formatConsoleTable.bind(this),
    formatConsoleValue: this.formatConsoleValue.bind(this),
    consoleBudget: this.consoleBudget.bind(this),
    consoleTableColumns: this.consoleTableColumns.bind(this),
    consoleTableRows: this.consoleTableRows.bind(this),
    formatConsoleTableCell: this.formatConsoleTableCell.bind(this),
    consoleTableValues: this.consoleTableValues.bind(this),
  }))(this);
  fork(): Interpreter<R> {
    return new Interpreter(
      this.invokeTool,
      this.toolKeys,
      this.logs,
      this.deadline,
      this.onToolCallLifecycle,
      this,
    );
  }

  constructor(
    invokeTool: (
      path: ReadonlyArray<string>,
      args: InterpreterArray,
      lifecycleId?: number,
    ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>,
    logs: Array<string> = [],
    deadline: ExecutionDeadline = new ExecutionDeadline(undefined),
    onToolCallLifecycle?: (
      event: ToolRuntime.ToolCallLifecycleEvent,
    ) => Effect.Effect<void, never, R>,
    parent?: Interpreter<R>,
  ) {
    this.execution = parent?.execution ?? {
      nextToolCallLifecycleId: 0,
      activePromises: 0,
      scope: Scope.makeUnsafe(),
      turns: new GuestTurns(),
      interrupting: new Set(),
    };
    this.owners = parent?.owners ?? [];
    this.turn = parent?.turn ?? { held: false };
    this.scopes = parent?.scopes.slice() ?? [];
    this.invokeTool = invokeTool;
    this.onToolCallLifecycle = onToolCallLifecycle;
    this.toolKeys = toolKeys;
    this.logs = logs;
    this.deadline = deadline;
    this.lastValue = undefined;
    this.callPermits = parent?.callPermits ?? Semaphore.makeUnsafe(TOOL_CALL_CONCURRENCY);
    this.pendingSettlements = parent?.pendingSettlements ?? this.pendingSettlements;
    if (parent !== undefined) return;
    const globalScope = new Map<string, Binding>();
    this.scopes.push(globalScope);
    globalScope.set("tools", { mutable: false, value: new ToolReference([]) });
    globalScope.set("Symbol", { mutable: false, value: new GlobalNamespace("Symbol") });
    globalScope.set("Promise", { mutable: false, value: new PromiseNamespace() });
    globalScope.set("undefined", { mutable: false, value: undefined });
    globalScope.set("Object", { mutable: false, value: new GlobalNamespace("Object") });
    globalScope.set("Math", { mutable: false, value: new GlobalNamespace("Math") });
    globalScope.set("JSON", { mutable: false, value: new GlobalNamespace("JSON") });
    globalScope.set("Number", { mutable: false, value: new CoercionFunction("Number") });
    globalScope.set("String", { mutable: false, value: new CoercionFunction("String") });
    globalScope.set("Boolean", { mutable: false, value: new CoercionFunction("Boolean") });
    globalScope.set("Array", { mutable: false, value: new GlobalNamespace("Array") });
    globalScope.set("console", { mutable: false, value: new GlobalNamespace("console") });
    globalScope.set("parseInt", { mutable: false, value: new CoercionFunction("parseInt") });
    globalScope.set("parseFloat", { mutable: false, value: new CoercionFunction("parseFloat") });
    globalScope.set("Date", { mutable: false, value: new GlobalNamespace("Date") });
    globalScope.set("RegExp", { mutable: false, value: new GlobalNamespace("RegExp") });
    globalScope.set("Map", { mutable: false, value: new GlobalNamespace("Map") });
    globalScope.set("Set", { mutable: false, value: new GlobalNamespace("Set") });
    globalScope.set("URL", { mutable: false, value: new GlobalNamespace("URL") });
    globalScope.set("URLSearchParams", {
      mutable: false,
      value: new GlobalNamespace("URLSearchParams"),
    });
    globalScope.set("encodeURI", { mutable: false, value: new UriFunction("encodeURI") });
    globalScope.set("encodeURIComponent", {
      mutable: false,
      value: new UriFunction("encodeURIComponent"),
    });
    globalScope.set("decodeURI", { mutable: false, value: new UriFunction("decodeURI") });
    globalScope.set("decodeURIComponent", {
      mutable: false,
      value: new UriFunction("decodeURIComponent"),
    });
    // Error constructors are real values, so `x instanceof Error` works and `Error("msg")`
    // (with or without `new`) constructs a branded { name, message } error object.
    for (const name of errorConstructors) {
      globalScope.set(name, { mutable: false, value: new ErrorConstructorReference(name) });
    }
    // NaN/Infinity flow as ordinary in-sandbox values (normalized to null only at the data
    // boundary - see copyOut), so their global bindings must exist too, e.g. `reduce(max, -Infinity)`.
    globalScope.set("NaN", { mutable: false, value: NaN });
    globalScope.set("Infinity", { mutable: false, value: Infinity });
  }

  run(program: ProgramNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = executionOps.run<R>;
    return operation.call(this.executionHost, program);
  }

  releaseTurn(): Effect.Effect<void> {
    const operation = executionOps.releaseTurn<R>;
    return operation.call(this.executionHost);
  }

  startPromise(
    work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants?: Set<SandboxPromise>,
    settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>(),
  ): Effect.Effect<SandboxPromise, never, R> {
    const operation = executionOps.startPromise<R>;
    return operation.call(this.executionHost, work, descendants, settlement);
  }

  interruptPromise(promise: SandboxPromise, raceInterrupted: boolean): Effect.Effect<void> {
    const operation = executionOps.interruptPromise<R>;
    return operation.call(this.executionHost, promise, raceInterrupted);
  }

  // Promise reactions run after the current synchronous guest turn, including reactions
  // to already-fulfilled values. Never hold a guest turn while waiting on a promise.
  promiseReaction<A, B, Requirements = never>(
    settlement: Effect.Effect<A, RuntimeFailure>,
    reaction: (value: A) => Effect.Effect<B, RuntimeFailure, Requirements>,
  ): Effect.Effect<B, RuntimeFailure, Requirements> {
    const operation = executionOps.promiseReaction<R, A, B, Requirements>;
    return operation.call(this.executionHost, settlement, reaction);
  }

  // Awaits every fiber-backed promise the program abandoned (fire-and-forget tool calls), so
  // their work completes before the execution ends - mirroring a JS runtime waiting on
  // in-flight I/O at exit. A failure nobody could have handled becomes an unhandled-rejection
  // diagnostic (interrupted calls, e.g. Promise.race losers, are ignored).
  drainPendingSettlements(): Effect.Effect<void, RuntimeFailure, never> {
    const operation = executionOps.drainPendingSettlements<R>;
    return operation.call(this.executionHost);
  }

  // Eagerly starts a tool call on a supervised child fiber (so the execution timeout and
  // scope teardown interrupt it) gated by the concurrency semaphore, and wraps the fiber in a
  // first-class promise value. The additive lifecycle observer sees queue admission before
  // semaphore acquisition and terminal interruption as cancellation; the legacy start/end
  // hooks retain their existing post-permit semantics.
  createToolCallPromise(
    path: ReadonlyArray<string>,
    args: InterpreterArray,
  ): Effect.Effect<SandboxPromise, never, R> {
    const operation = executionOps.createToolCallPromise<R>;
    return operation.call(this.executionHost, path, args);
  }

  // The promise's settlement as an Exit, marking it observed for unhandled-rejection tracking.
  // Fiber settlement is idempotent, so observing the same promise repeatedly (await twice,
  // Promise.all([p, p])) never re-runs the underlying call.
  observePromise(
    promise: SandboxPromise,
  ): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
    const operation = executionOps.observePromise<R>;
    return operation.call(this.executionHost, promise);
  }

  promiseSettlement(
    promise: SandboxPromise,
  ): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
    const operation = executionOps.promiseSettlement<R>;
    return operation.call(this.executionHost, promise);
  }

  // `await promise`: succeed with the fulfilled value or re-raise the failure so try/catch
  // observes it exactly like a synchronous throw at the await site.
  settlePromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, never> {
    const operation = executionOps.settlePromise<R>;
    return operation.call(this.executionHost, promise, node);
  }

  unwrapPromiseExit(
    promise: SandboxPromise | undefined,
    exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure> {
    const operation = executionOps.unwrapPromiseExit<R>;
    return operation.call(this.executionHost, promise, exit, node);
  }

  evaluateStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateBlock(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateBlock<R>;
    return operation.call(this.statementsHost, node);
  }

  createFunction(node: AstNode): CodeModeFunction {
    const operation = callableOps.createFunction<R>;
    return operation.call(this.callableHost, node);
  }

  // Function declarations are hoisted: bound in their scope before the body runs, so a
  // program can call a helper defined further down (matching JavaScript).
  hoistFunctions(statements: Array<AstPropertyValue>): void {
    const operation = statementsOps.hoistFunctions<R>;
    return operation.call(this.statementsHost, statements);
  }

  evaluateIfStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateIfStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateSwitchStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateSwitchStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateWhileStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateWhileStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateDoWhileStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateDoWhileStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateForStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateForStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateForOfStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateForOfStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  // Own enumerable string keys of a value, shared by `for...in` and `Object.keys` over tool
  // references: plain data objects enumerate their own keys, arrays their index strings (plus
  // any own non-index properties, e.g. match results' index/groups - exactly Object.keys in
  // JS), and a tool reference the namespace/tool names at its path in the host tool tree.
  // Returns undefined for everything else so callers can raise a contextual error.
  enumerableKeys<ValueInput>(value: ValueInput): Array<string> | undefined {
    const operation = statementsOps.enumerableKeys<R, ValueInput>;
    return operation.call(this.statementsHost, value);
  }

  evaluateForInStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateForInStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateBreakStatement(node: AstNode): StatementResult {
    const operation = statementsOps.evaluateBreakStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateContinueStatement(node: AstNode): StatementResult {
    const operation = statementsOps.evaluateContinueStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateThrowStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateThrowStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateTryStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R> {
    const operation = statementsOps.evaluateTryStatement<R>;
    return operation.call(this.statementsHost, node);
  }

  evaluateVariableDeclaration(node: AstNode): Effect.Effect<void, RuntimeFailure, R> {
    const operation = bindingsOps.evaluateVariableDeclaration<R>;
    return operation.call(this.bindingsHost, node);
  }

  declarePattern(
    pattern: AstNode,
    value: InterpreterValue,
    mutable: boolean,
    node: AstNode,
    kind?: "var",
  ): Effect.Effect<void, RuntimeFailure, R> {
    const operation = bindingsOps.declarePattern<R>;
    return operation.call(this.bindingsHost, pattern, value, mutable, node, kind);
  }

  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateNewExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = constructorsOps.evaluateNewExpression<R>;
    return operation.call(this.constructorsHost, node);
  }

  constructDate(args: InterpreterArray): SandboxDate {
    const operation = constructorsOps.constructDate<R>;
    return operation.call(this.constructorsHost, args);
  }

  constructRegExp(args: InterpreterArray, node: AstNode): SandboxRegExp {
    const operation = constructorsOps.constructRegExp<R>;
    return operation.call(this.constructorsHost, args, node);
  }

  constructMap<InitInput>(init: InitInput, node: AstNode): SandboxMap {
    const operation = constructorsOps.constructMap<R, InitInput>;
    return operation.call(this.constructorsHost, init, node);
  }

  constructSet<InitInput>(init: InitInput, node: AstNode): SandboxSet {
    const operation = constructorsOps.constructSet<R, InitInput>;
    return operation.call(this.constructorsHost, init, node);
  }

  constructURL(args: InterpreterArray, node: AstNode): SandboxURL {
    const operation = constructorsOps.constructURL<R>;
    return operation.call(this.constructorsHost, args, node);
  }

  constructURLSearchParams<InitInput>(init: InitInput, node: AstNode): SandboxURLSearchParams {
    const operation = constructorsOps.constructURLSearchParams<R, InitInput>;
    return operation.call(this.constructorsHost, init, node);
  }

  evaluateBinaryExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateBinaryExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  /**
   * Applies a binary operator to two already-evaluated operands with CodeMode's coercion
   * semantics. Shared by binary expressions and compound assignment (`x op= y` must behave
   * exactly like `x = x op y`, coercion included).
   */
  applyBinaryOperator(
    operator: string,
    lhs: InterpreterValue,
    rhs: InterpreterValue,
    node: AstNode,
  ): InterpreterValue {
    const operation = expressionsOps.applyBinaryOperator<R>;
    return operation.call(this.expressionsHost, operator, lhs, rhs, node);
  }

  evaluateLogicalExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateLogicalExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateUnaryExpression(node: AstNode) {
    const operation = expressionsOps.evaluateUnaryExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateAssignmentExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateAssignmentExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateLogicalAssignment(
    node: AstNode,
    left: AstNode,
    operator: string,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateLogicalAssignment<R>;
    return operation.call(this.expressionsHost, node, left, operator);
  }

  evaluateUpdateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateUpdateExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateCallExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = callableOps.evaluateCallExpression<R>;
    return operation.call(this.callableHost, node);
  }

  invokeCallable(
    callable: InterpreterValue,
    args: InterpreterArray,
    node: AstNode,
    callee = node,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = callableOps.invokeCallable<R>;
    return operation.call(this.callableHost, callable, args, node, callee);
  }

  // Object.* over a tool reference: `Object.keys(tools)` / `Object.keys(tools.ns)` enumerate
  // namespace/tool names from the host tool tree - the discovery idiom a model reaches for
  // first. Every other Object helper cannot produce data from a tool reference, so it fails
  // with a pointer at the working idioms instead of the generic plain-objects-only message.
  invokeObjectMethodOnTools(name: string, ref: ToolReference, node: AstNode) {
    const operation = consoleOps.invokeObjectMethodOnTools<R>;
    return operation.call(this.consoleHost, name, ref, node);
  }

  invokeConsole(name: string, args: InterpreterArray, node: AstNode): undefined {
    const operation = consoleOps.invokeConsole<R>;
    return operation.call(this.consoleHost, name, args, node);
  }

  formatConsoleMessage(name: string, args: InterpreterArray): string {
    const operation = consoleOps.formatConsoleMessage<R>;
    return operation.call(this.consoleHost, name, args);
  }

  // Console arguments format deeply and totally: values render as a debugger would show them
  // rather than as boundary JSON - numbers keep NaN/Infinity (JSON would say null), sandbox
  // values keep their friendly forms at ANY depth (ISO date, /regex/flags, Map(n) [...],
  // Set(n) [...]), opaque runtime references become "[CodeMode reference]" markers in place,
  // and plain objects/arrays render JSON-style. Formatting never fails the program: cycles
  // render "[Circular]" and extreme depth degrades to "...".
  formatConsoleArgument<ValueInput>(value: ValueInput): string {
    const operation = consoleOps.formatConsoleArgument<R, ValueInput>;
    return operation.call(this.consoleHost, value);
  }

  // Confinement: rendering is charged against a per-entry character budget so a huge (but
  // individually admitted) structure cannot materialize an unbounded native string before
  // appendBoundedLog truncates the entry.
  consoleBudget() {
    const operation = consoleOps.consoleBudget<R>;
    return operation.call(this.consoleHost);
  }

  formatConsoleValue<ValueInput>(
    value: ValueInput,
    seen: Set<object>,
    depth: number,
    budget: { remaining: number },
  ): string {
    const operation = consoleOps.formatConsoleValue<R, ValueInput>;
    return operation.call(this.consoleHost, value, seen, depth, budget);
  }

  formatConsoleTable(value: InterpreterValue, columnsArgument: InterpreterValue): string {
    const operation = consoleOps.formatConsoleTable<R>;
    return operation.call(this.consoleHost, value, columnsArgument);
  }

  consoleTableColumns(value: InterpreterValue): ReadonlyArray<string> | undefined {
    const operation = consoleOps.consoleTableColumns<R>;
    return operation.call(this.consoleHost, value);
  }

  consoleTableRows(
    data: InterpreterValue,
    columns: ReadonlyArray<string> | undefined,
  ): Array<{ readonly index: string; readonly values: InterpreterObject }> {
    const operation = consoleOps.consoleTableRows<R>;
    return operation.call(this.consoleHost, data, columns);
  }

  consoleTableValues(value: InterpreterValue, columns: ReadonlyArray<string> | undefined) {
    const operation = consoleOps.consoleTableValues<R>;
    return operation.call(this.consoleHost, value, columns);
  }

  formatConsoleTableCell(value: InterpreterValue): string {
    const operation = consoleOps.formatConsoleTableCell<R>;
    return operation.call(this.consoleHost, value);
  }

  evaluateCallArguments(
    argNodes: Array<AstPropertyValue>,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
    const operation = callableOps.evaluateCallArguments<R>;
    return operation.call(this.callableHost, argNodes);
  }

  constructAggregateError(args: InterpreterArray, node: AstNode): InterpreterObject {
    const operation = promisesOps.constructAggregateError<R>;
    return operation.call(this.promisesHost, args, node);
  }

  chainReaction(
    source: SandboxPromise,
    reaction: (
      exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
    ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants: Set<SandboxPromise>,
  ): Effect.Effect<SandboxPromise, never, R> {
    const operation = promisesOps.chainReaction<R>;
    return operation.call(this.promisesHost, source, reaction, descendants);
  }

  invokePromiseChain(
    source: SandboxPromise,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<SandboxPromise, never, R> {
    const operation = promisesOps.invokePromiseChain<R>;
    return operation.call(this.promisesHost, source, name, args, node);
  }

  // Promise.* over ordinary runtime values. Combinators accept ANY array (or spreadable
  // collection) mixing promise values and plain data - built inline, beforehand, via spread,
  // whatever - because tool calls already run eagerly on their own fibers. Combinators
  // observe settlements without holding a guest turn; tool concurrency stays at admission.
  invokePromiseMethod(
    ref: PromiseMethodReference,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = promisesOps.invokePromiseMethod<R>;
    return operation.call(this.promisesHost, ref, args, node);
  }

  evaluatePromiseMethod(
    ref: PromiseMethodReference,
    args: InterpreterArray,
    node: AstNode,
    settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>(),
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = promisesOps.evaluatePromiseMethod<R>;
    return operation.call(this.promisesHost, ref, args, node, settlement);
  }

  invokeFunction(
    fn: CodeModeFunction,
    args: InterpreterArray,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = callableOps.invokeFunction<R>;
    return operation.call(this.callableHost, fn, args);
  }

  evaluateFunction(
    fn: CodeModeFunction,
    args: InterpreterArray,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = callableOps.evaluateFunction<R>;
    return operation.call(this.callableHost, fn, args);
  }

  invokeIntrinsic(
    ref: IntrinsicReference,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = callableOps.invokeIntrinsic<R>;
    return operation.call(this.callableHost, ref, args, node);
  }

  invokeStringReplacer(
    value: string,
    name: "replace" | "replaceAll",
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = iterationOps.invokeStringReplacer<R>;
    return operation.call(this.iterationHost, value, name, args, node);
  }

  // Runs a collection callback accepting a user function or supported builtin callable,
  // mirroring the array-method callback contract.
  applyCollectionCallback(
    callback: InterpreterValue,
    name: string,
    node: AstNode,
  ): (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = iterationOps.applyCollectionCallback<R>;
    return operation.call(this.iterationHost, callback, name, node);
  }

  invokeMapMethod(
    target: SandboxMap,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = iterationOps.invokeMapMethod<R>;
    return operation.call(this.iterationHost, target, name, args, node);
  }

  invokeSetMethod(
    target: SandboxSet,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = iterationOps.invokeSetMethod<R>;
    return operation.call(this.iterationHost, target, name, args, node);
  }

  invokeURLSearchParamsMethod(
    target: SandboxURLSearchParams,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = iterationOps.invokeURLSearchParamsMethod<R>;
    return operation.call(this.iterationHost, target, name, args, node);
  }

  // Local compatibility addition: mapping must run inside the interpreter, not a native
  // Array.from callback. Preserve live iteration while bounding growth before mapper effects.
  invokeArrayFrom(
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = builtinsOps.invokeArrayFrom<R>;
    return operation.call(this.builtinsHost, args, node);
  }

  invokeArrayMethod(
    target: InterpreterArray,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = builtinsOps.invokeArrayMethod<R>;
    return operation.call(this.builtinsHost, target, name, args, node);
  }

  sortArray(
    target: InterpreterArray,
    comparator: InterpreterValue,
    node: AstNode,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
    const operation = builtinsOps.sortArray<R>;
    return operation.call(this.builtinsHost, target, comparator, node);
  }

  evaluateObjectExpression(node: AstNode): Effect.Effect<InterpreterObject, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateObjectExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateArrayExpression(node: AstNode): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateArrayExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateTemplateLiteral(node: AstNode): Effect.Effect<string, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateTemplateLiteral<R>;
    return operation.call(this.expressionsHost, node);
  }

  evaluateConditionalExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = expressionsOps.evaluateConditionalExpression<R>;
    return operation.call(this.expressionsHost, node);
  }

  applyCompoundAssignment(
    operator: string,
    current: InterpreterValue,
    incoming: InterpreterValue,
    node: AstNode,
  ): InterpreterValue {
    const operation = expressionsOps.applyCompoundAssignment<R>;
    return operation.call(this.expressionsHost, operator, current, incoming, node);
  }

  getMemberReference(
    node: AstNode,
  ): Effect.Effect<
    | MemberReference
    | ToolReference
    | PromiseMethodReference
    | IntrinsicReference
    | GlobalMethodReference
    | ComputedValue
    | typeof OptionalShortCircuit
    | undefined,
    RuntimeFailure,
    R
  > {
    const operation = membersOps.getMemberReference<R>;
    return operation.call(this.membersHost, node);
  }

  readMember(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = membersOps.readMember<R>;
    return operation.call(this.membersHost, node);
  }

  writeMember(
    node: AstNode,
    value: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = membersOps.writeMember<R>;
    return operation.call(this.membersHost, node, value);
  }

  // Resolves the member reference EXACTLY ONCE (so a side-effecting object/key expression
  // runs once), then lets `compute` decide whether to write - enabling compound assignment,
  // updates, plain writes, and short-circuiting logical assignment to share one safe path.
  modifyMember(
    node: AstNode,
    compute: (
      current: InterpreterValue,
    ) => Effect.Effect<
      { write: boolean; next: InterpreterValue; result: InterpreterValue },
      RuntimeFailure,
      R
    >,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
    const operation = membersOps.modifyMember<R>;
    return operation.call(this.membersHost, node, compute);
  }

  // Rejects inserting a value that (transitively) contains the container it is being inserted
  // into - the mutation that would create a circular structure no later walk could survive.
  rejectCircularInsertion(
    container: InterpreterObject | InterpreterArray,
    value: InterpreterValue,
    label: string,
    node: AstNode,
    seen = new Set<object>(),
  ): void {
    const operation = membersOps.rejectCircularInsertion<R>;
    return operation.call(this.membersHost, container, value, label, node, seen);
  }

  assignToReference(
    reference: MemberReference,
    key: GuestPropertyKey,
    next: InterpreterValue,
    node: AstNode,
  ): void {
    const operation = membersOps.assignToReference<R>;
    return operation.call(this.membersHost, reference, key, next, node);
  }

  toPropertyKey(value: InterpreterValue, node: AstNode): GuestPropertyKey {
    const operation = membersOps.toPropertyKey<R>;
    return operation.call(this.membersHost, value, node);
  }

  declare(name: string, value: InterpreterValue, mutable: boolean, node: AstNode): void {
    const operation = scopeOps.declare<R>;
    return operation.call(this.scopeHost, name, value, mutable, node);
  }

  getIdentifierValue(name: string, node: AstNode) {
    const operation = scopeOps.getIdentifierValue<R>;
    return operation.call(this.scopeHost, name, node);
  }

  setIdentifierValue(name: string, value: InterpreterValue, node: AstNode) {
    const operation = scopeOps.setIdentifierValue<R>;
    return operation.call(this.scopeHost, name, value, node);
  }

  resolveBinding(name: string): Binding | undefined {
    const operation = scopeOps.resolveBinding<R>;
    return operation.call(this.scopeHost, name);
  }

  currentScope(): Map<string, Binding> {
    const operation = scopeOps.currentScope<R>;
    return operation.call(this.scopeHost);
  }

  pushScope(): void {
    const operation = scopeOps.pushScope<R>;
    return operation.call(this.scopeHost);
  }

  popScope(): void {
    const operation = scopeOps.popScope<R>;
    return operation.call(this.scopeHost);
  }
}

export { caughtErrorValue, normalizeError, parseProgram } from "./diagnostics.js";
export { invokeArrayStatic, invokeGlobalMethod } from "./globals.js";
export { executeWithLimits } from "./host-execution.js";
export {
  containsOpaqueReference,
  containsRuntimeReference,
  instanceofValue,
  isRuntimeReference,
  typeofValue,
} from "./references.js";
export { invokeStringMethod } from "./string-operations.js";
