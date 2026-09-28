import * as Predicate from "effect/Predicate";

/**
 * The built-in operations one kind of guest value answers to, keyed by name. The key set is the
 * allowlist: member access admits exactly these names and dispatch runs exactly these
 * operations, so the two cannot drift apart.
 */
export class MethodTable<Operation> {
  private readonly operations: ReadonlyMap<string, Operation>;

  constructor(operations: Readonly<Record<string, Operation>>) {
    this.operations = new Map(Object.entries(operations));
  }

  has(name: PropertyKey): boolean {
    return Predicate.isString(name) && this.operations.has(name);
  }

  get(name: string): Operation | undefined {
    return this.operations.get(name);
  }

  get names(): ReadonlyArray<string> {
    return [...this.operations.keys()];
  }
}
