import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** Adds the Pi extension API contract to a fixture while keeping its concrete members. */
export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Each test uses only the ExtensionAPI members its fixture implements.
  return fixture as Fixture & ExtensionAPI;
};

/** One fixture usable at both extension-event and command callback boundaries. */
export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Each test uses only the host context members its fixture implements.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};

/** An opaque host value, such as a TUI or keybindings manager, typed for any target. */
export const opaqueFixture = <Value>(value: Value): never => {
  // SAFETY: Each test supplies every opaque host member its subject exercises.
  return value as never;
};

const unstyled = (_token: string, text: string) => text;
const plain = (text: string) => text;

/** Identity styling: every text style returns its input unchanged. */
export const plainTheme =
  // SAFETY: Renderers under test call only these text-styling members of Theme.
  Object.freeze({
    fg: unstyled,
    bg: unstyled,
    bold: plain,
    italic: plain,
    underline: plain,
    inverse: plain,
    strikethrough: plain,
  }) as Theme;

/** A Promise the test settles explicitly; later settlements are ignored. */
export const deferredPromise = <A = void>() => {
  const deferred = Deferred.makeUnsafe<A, Error>();
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: (value: A): void => {
      Deferred.doneUnsafe(deferred, Effect.succeed(value));
    },
    reject: (error: Error): void => {
      Deferred.doneUnsafe(deferred, Effect.fail(error));
    },
  };
};
