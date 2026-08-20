import * as Predicate from "effect/Predicate";

import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";

export { invokeHostCallback };

export class XaiHostUiError extends Schema.TaggedError<XaiHostUiError>()("XaiHostUiError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Isolates synchronous Pi UI callbacks from the Effect application error channel. */
const tryHostUi = <A>(operation: string, action: () => A) =>
  Effect.try({
    try: action,
    catch: () =>
      new XaiHostUiError({ operation, message: "Unable to update Better xAI settings UI." }),
  });

/** Best-effort Effect adapter: a failing host UI call is logged, never propagated. */
export const recoverHostUi = <Result>(operation: string, action: () => Result) =>
  tryHostUi(operation, action).pipe(
    Effect.catchTag("XaiHostUiError", () =>
      Effect.logWarning(`Better xAI UI recovery: ${operation}_failed.`),
    ),
    Effect.asVoid,
  );

/** Fail-closed capability check for the interactive settings surface. */
export function hasSettingsSurface(ctx: ExtensionContext): boolean {
  return invokeHostCallback(() => ctx.mode === "tui" && Predicate.isFunction(ctx.ui.custom), false);
}

export type XaiSettingsSurfaceFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: undefined) => void,
) => Component & { dispose?(): void };

export type XaiHostSurfaceOutcome = "closed" | "failed";

const neutralSurfaceComponent = (): ReturnType<XaiSettingsSurfaceFactory> => ({
  render: () => [],
  invalidate: () => undefined,
  handleInput: () => undefined,
  dispose: () => undefined,
});

/**
 * Guard the Promise-shaped custom-surface open and the host-invoked factory. Pi may call the
 * factory after this function returns, so factory and `done` protection must live in the wrapper
 * retained by the host rather than only around the initial `custom` call.
 */
export function openSettingsSurfaceAtHostBoundary(
  ctx: ExtensionContext,
  factory: XaiSettingsSurfaceFactory,
): Promise<XaiHostSurfaceOutcome> {
  let factoryFailed = false;
  const guardedFactory: XaiSettingsSurfaceFactory = (tui, theme, keybindings, done) => {
    const guardedDone = (result: undefined): void => {
      invokeHostCallback(() => done(result), undefined);
    };
    const created = invokeHostCallback<
      | { readonly _tag: "Created"; readonly component: ReturnType<XaiSettingsSurfaceFactory> }
      | { readonly _tag: "Failed" }
    >(
      () => ({
        _tag: "Created" as const,
        component: factory(tui, theme, keybindings, guardedDone),
      }),
      { _tag: "Failed" as const },
    );
    if (created._tag === "Created") return created.component;
    factoryFailed = true;
    guardedDone(undefined);
    return neutralSurfaceComponent();
  };

  try {
    return Promise.resolve(ctx.ui.custom<undefined>(guardedFactory)).then(
      (): XaiHostSurfaceOutcome => (factoryFailed ? "failed" : "closed"),
      (): XaiHostSurfaceOutcome => "failed",
    );
  } catch {
    return Promise.resolve("failed");
  }
}
