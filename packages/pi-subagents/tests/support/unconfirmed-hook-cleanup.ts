import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Core from "pi-cosmic-core";
import { vi } from "vitest";

const originalRun = Core.runBoundedProcessNode;

/**
 * While the returned spy is installed, every `/bin/sh` process (the tests' worktree hooks) runs as
 * usual but reports that its process group couldn't be confirmed stopped; Git runs untouched.
 */
export const unconfirmedShellCleanup = () =>
  vi
    .spyOn(Core, "runBoundedProcessNode")
    .mockImplementation((request) =>
      request.executable === "/bin/sh"
        ? originalRun(request).pipe(
            Effect.map((result) => Object.assign(result, { cleanupUnconfirmed: true })),
          )
        : originalRun(request),
    );

/**
 * Collects the workspace each warning names, from its `workspaceId` annotation, for effects the
 * returned layer is provided to.
 */
export const capturedWarnings = () => {
  const workspaceIds: unknown[] = [];
  const logger = Logger.make((options) => {
    const entry = Logger.formatStructured.log(options);
    if (entry.level === "WARN") workspaceIds.push(entry.annotations["workspaceId"]);
  });
  return { workspaceIds, layer: Logger.layer([logger]) };
};
