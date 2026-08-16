import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { AdvisorModelError } from "./client.ts";
import { isolateCallback, toModelError } from "./session.ts";
import { ADVISOR_TOOL_NAMES, isPackageAdvisorTool } from "./tools.ts";
import { AdvisorRuntimeResetRequiredError, type ActiveAdvisorChild } from "./types.ts";

export const makeAdvisorSessionSafety = (port: {
  readonly activeChild: SynchronizedRef.SynchronizedRef<ActiveAdvisorChild | undefined>;
  readonly resetRequiredReason: () => string | undefined;
  readonly onDiagnostic: (message: string) => void;
  readonly dispose: () => Effect.Effect<void>;
}) => {
  const requireChildEffect = () =>
    SynchronizedRef.get(port.activeChild).pipe(
      Effect.flatMap((active) => {
        const resetRequiredReason = port.resetRequiredReason();
        if (resetRequiredReason)
          return Effect.fail(
            new AdvisorRuntimeResetRequiredError({ message: resetRequiredReason }),
          );
        return active
          ? Effect.succeed(active)
          : Effect.fail(new AdvisorModelError({ message: "Advisor runtime is not started." }));
      }),
    );

  const requireSessionEffect = () =>
    requireChildEffect().pipe(Effect.map((active) => active.session));

  const failSafetyEffect = (message: string) =>
    Effect.sync(() => isolateCallback(() => port.onDiagnostic(message))).pipe(
      Effect.andThen(
        Effect.fail(
          new AdvisorModelError({ message: `Advisor runtime safety check failed: ${message}` }),
        ),
      ),
    );

  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const assertSessionSafeToolsEffect = (session: AgentSession) =>
    Effect.gen(function* () {
      const activeToolNames = yield* Effect.try({
        try: () => [...session.getActiveToolNames()],
        catch: toModelError("Advisor active tool metadata could not be read."),
      });
      for (const name of activeToolNames) {
        if (!(ADVISOR_TOOL_NAMES as readonly string[]).includes(name))
          return yield* failSafetyEffect(`Unsafe Advisor tool became active: ${name}`);
        const definition = yield* Effect.try({
          try: () => session.getToolDefinition(name),
          catch: toModelError("Advisor tool definition metadata could not be read."),
        });
        if (!isPackageAdvisorTool(definition))
          return yield* failSafetyEffect(`Advisor tool identity mismatch: ${name}`);
      }
    });

  const assertSafeToolsEffect = () =>
    requireSessionEffect().pipe(Effect.flatMap(assertSessionSafeToolsEffect));

  const fatalSafetyFailureEffect = (message: string) =>
    port
      .dispose()
      .pipe(
        Effect.ensuring(Effect.sync(() => isolateCallback(() => port.onDiagnostic(message)))),
        Effect.andThen(Effect.fail(new AdvisorModelError({ message }))),
      );

  return {
    requireChildEffect,
    requireSessionEffect,
    assertSafeToolsEffect,
    assertSessionSafeToolsEffect,
    fatalSafetyFailureEffect,
  } as const;
};
