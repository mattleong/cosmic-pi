import type { ProcessTreeTerminatorSpawn } from "../platform/process-tree.ts";

type TerminatorEvent = "exit" | "error";
type TerminatorListener = (result: Error | number | null) => void;

/** Platform-neutral fake taskkill helper, so terminator semantics are testable everywhere. */
export const fakeProcessTreeTerminator = () => {
  const listeners = new Map<TerminatorEvent, TerminatorListener[]>();
  const spawns: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const killed: string[] = [];
  let unrefed = false;
  const spawn: ProcessTreeTerminatorSpawn = (command, args) => {
    spawns.push({ command, args });
    return {
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      removeListener: (event, listener) =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((item) => item !== listener),
        ),
      kill: (signal) => killed.push(signal),
      unref: () => {
        unrefed = true;
      },
    };
  };
  return {
    spawn,
    spawns,
    killed,
    isUnrefed: () => unrefed,
    emit: (event: TerminatorEvent, result: Error | number | null) => {
      for (const listener of listeners.get(event) ?? []) listener(result);
    },
    listenerCounts: () => ({
      exit: listeners.get("exit")?.length ?? 0,
      error: listeners.get("error")?.length ?? 0,
    }),
  };
};
