// Local confined Set algebra. Only owned wrappers may supply membership and keys.
import { SandboxMap, SandboxSet } from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import { ExecutionDeadline } from "./deadline.js";
import { InterpreterRuntimeError } from "./model.js";
import type { AstNode, InterpreterValue } from "./model.js";

export type SetOperation =
  | "union"
  | "intersection"
  | "difference"
  | "symmetricDifference"
  | "isSubsetOf"
  | "isSupersetOf"
  | "isDisjointFrom";

export const invokeSetOperation = (
  target: SandboxSet,
  name: SetOperation,
  operand: InterpreterValue,
  deadline: ExecutionDeadline,
  node?: AstNode,
): SandboxSet | boolean => {
  deadline.check(node);
  if (!(operand instanceof SandboxSet) && !(operand instanceof SandboxMap)) {
    throw new InterpreterRuntimeError(
      `Set.${name} requires a Set or Map; custom set-like objects are not supported.`,
      node,
    ).as("TypeError");
  }
  const left = target.set;
  const right = operand instanceof SandboxSet ? operand.set : operand.map;
  const label = `Set.${name}`;
  assertBoundedCollectionSize(left.size, label, node);
  assertBoundedCollectionSize(right.size, label, node);

  if (name === "isSubsetOf") {
    if (left.size > right.size) return false;
    for (const key of left) {
      deadline.check(node);
      if (!right.has(key)) return false;
    }
    return true;
  }
  if (name === "isSupersetOf") {
    if (left.size < right.size) return false;
    for (const key of right.keys()) {
      deadline.check(node);
      if (!left.has(key)) return false;
    }
    return true;
  }
  if (name === "isDisjointFrom") {
    const smaller = left.size <= right.size ? left : right;
    const larger = left.size <= right.size ? right : left;
    for (const key of smaller.keys()) {
      deadline.check(node);
      if (larger.has(key)) return false;
    }
    return true;
  }

  // These wrappers cannot execute guest code while traversed. Count the exact output
  // before allocating it, then repeat the same bounded traversal to preserve identity.
  const visit = (emit: (key: InterpreterValue) => void): void => {
    if (name === "intersection") {
      const smaller = left.size <= right.size ? left : right;
      const larger = left.size <= right.size ? right : left;
      for (const key of smaller.keys()) {
        deadline.check(node);
        if (larger.has(key)) emit(key);
      }
      return;
    }
    for (const key of left) {
      deadline.check(node);
      if (name === "union" || !right.has(key)) emit(key);
    }
    if (name === "union" || name === "symmetricDifference") {
      for (const key of right.keys()) {
        deadline.check(node);
        if (!left.has(key)) emit(key);
      }
    }
  };

  // Native difference scans the smaller operand. Copy/delete retains left order.
  if (name === "difference" && left.size > right.size) {
    assertBoundedCollectionSize(left.size, label, node);
    const result = new SandboxSet();
    for (const key of left) {
      deadline.check(node);
      result.set.add(key);
    }
    for (const key of right.keys()) {
      deadline.check(node);
      result.set.delete(key);
    }
    return result;
  }
  let projected = 0;
  visit(() => {
    assertBoundedCollectionSize(++projected, label, node);
  });
  deadline.check(node);
  const result = new SandboxSet();
  visit((key) => result.set.add(key));
  return result;
};
