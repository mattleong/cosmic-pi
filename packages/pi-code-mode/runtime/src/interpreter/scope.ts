import {
  asNode,
  getArray,
  getNode,
  getString,
  isRecord,
  astProperty,
  type AstPropertyValue,
  type AstNode,
  type Binding,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "./model.js";
import { type Activation } from "./activation.js";
export interface ScopeHost<_R> {
  currentScope(): Map<string, Binding>;
  resolveBinding(name: string): Binding | undefined;
  scopes: Array<Map<string, Binding>>;
}

export function declare<R>(
  act: Activation<R>,
  name: string,
  value: InterpreterValue,
  mutable: boolean,
  node: AstNode,
): void {
  const scope = currentScope(act);

  // A pre-seeded parameter slot (initialized === false) is being bound for the first time;
  // anything else already present is a genuine duplicate declaration.
  const existing = scope.get(name);
  if (existing && existing.initialized !== false) {
    throw new InterpreterRuntimeError(`Identifier '${name}' has already been declared.`, node);
  }

  scope.set(name, { mutable, value, initialized: true });
}

export function getIdentifierValue<R>(act: Activation<R>, name: string, node: AstNode) {
  const binding = resolveBinding(act, name);

  if (!binding) {
    throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node).as("ReferenceError");
  }

  // A parameter default that forward-references a later (not-yet-bound) parameter - JS TDZ.
  if (binding.initialized === false) {
    throw new InterpreterRuntimeError(`Cannot access '${name}' before initialization.`, node).as(
      "ReferenceError",
    );
  }

  return binding.value;
}

export function setIdentifierValue<R>(
  act: Activation<R>,
  name: string,
  value: InterpreterValue,
  node: AstNode,
) {
  const binding = resolveBinding(act, name);

  if (!binding) {
    throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node).as("ReferenceError");
  }

  if (binding.initialized === false) {
    throw new InterpreterRuntimeError(`Cannot access '${name}' before initialization.`, node).as(
      "ReferenceError",
    );
  }

  if (!binding.mutable) {
    throw new InterpreterRuntimeError(`Cannot assign to constant '${name}'.`, node).as("TypeError");
  }

  binding.value = value;
  return value;
}

export function resolveBinding<R>(act: Activation<R>, name: string): Binding | undefined {
  for (let index = act.scopes.length - 1; index >= 0; index -= 1) {
    const scope = act.scopes[index];
    const binding = scope?.get(name);

    if (binding) {
      return binding;
    }
  }

  return undefined;
}

export function currentScope<R>(act: Activation<R>): Map<string, Binding> {
  const scope = act.scopes[act.scopes.length - 1];

  if (!scope) {
    throw new InterpreterRuntimeError("Interpreter scope stack is empty.");
  }

  return scope;
}

export function pushScope<R>(act: Activation<R>): void {
  act.scopes.push(new Map());
}

export function popScope<R>(act: Activation<R>): void {
  act.scopes.pop();
}

/** Binding names only; defaults and computed expressions are not declarations. */
export function patternNames(pattern: AstNode): Array<string> {
  switch (pattern.type) {
    case "Identifier":
      return [getString(pattern, "name")];
    case "AssignmentPattern":
      return patternNames(getNode(pattern, "left"));
    case "RestElement":
      return patternNames(getNode(pattern, "argument"));
    case "ArrayPattern":
      return getArray(pattern, "elements").flatMap((value) =>
        value === null ? [] : patternNames(asNode(value, "elements")),
      );
    case "ObjectPattern":
      return getArray(pattern, "properties").flatMap((value) => {
        const property = asNode(value, "properties");
        return patternNames(
          getNode(property, property.type === "RestElement" ? "argument" : "value"),
        );
      });
    default:
      return [];
  }
}

export function predeclareLexicals(
  scope: Map<string, Binding>,
  statements: ReadonlyArray<AstPropertyValue>,
): void {
  for (const value of statements) {
    const node = asNode(value, "body");
    if (node.type !== "VariableDeclaration" || getString(node, "kind") === "var") continue;
    for (const item of getArray(node, "declarations")) {
      for (const name of patternNames(getNode(asNode(item, "declarations"), "id"))) {
        if (scope.has(name))
          throw new InterpreterRuntimeError(
            `Identifier '${name}' has already been declared.`,
            node,
          );
        scope.set(name, {
          value: undefined,
          mutable: getString(node, "kind") !== "const",
          initialized: false,
        });
      }
    }
  }
}

/** Function-wide var scan. Never descend into a nested function's parameters or body. */
export function hoistVarDeclarations(
  scope: Map<string, Binding>,
  statements: ReadonlyArray<AstPropertyValue>,
): void {
  const visit = (value: AstPropertyValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const type = astProperty(value, "type");
    if (
      type === "FunctionDeclaration" ||
      type === "FunctionExpression" ||
      type === "ArrowFunctionExpression"
    )
      return;
    if (type === "VariableDeclaration" && astProperty(value, "kind") === "var") {
      const node = asNode(value, "declaration");
      for (const item of getArray(node, "declarations")) {
        for (const name of patternNames(getNode(asNode(item, "declarations"), "id"))) {
          if (!scope.has(name))
            scope.set(name, { value: undefined, mutable: true, initialized: true });
        }
      }
    }
    for (const key of Object.keys(value)) visit(astProperty(value, key));
  };
  for (const statement of statements) visit(statement);
}

/** The scope `var` declarations bind in: the function's own, or the program's top level. */
export function variableScope<R>(act: Activation<R>): Map<string, Binding> {
  const scope = act.functionScope ?? act.scopes[1];
  if (scope === undefined) throw new InterpreterRuntimeError("Missing function environment.");
  return scope;
}
