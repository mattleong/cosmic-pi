import type { Definition } from "./tool.js";
import type { HostTools } from "./tool-tree.js";

/** Plain tool trees remain valid; metadata never becomes a callable property. */
export type Tools<R = never> = {
  readonly [name: string]: Definition<R> | Tools<R>;
};

export type Options<T extends object> = {
  readonly description?: string;
  readonly tools: T;
};

const descriptions = new WeakMap<object, string>();

/** Host-only metadata lookup used by discovery. */
export const description = <R>(tools: HostTools<R>): string | undefined => descriptions.get(tools);

/** Describe a namespace without changing its keys, paths, or nested tool identities. */
export const make = <const T extends object>(options: Options<T>): T => {
  const tools = { ...options.tools };
  const text = options.description ?? descriptions.get(options.tools);
  if (text !== undefined) descriptions.set(tools, text);
  return tools;
};
