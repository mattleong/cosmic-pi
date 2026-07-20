import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Synchronous configuration boundary required by Pi's synchronous render APIs. */
export function environmentValue(name: string): string | undefined {
  const environment = Reflect.get(process, "env") as Record<string, string>;
  return Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(name)).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: environment }),
        ),
      ),
    ),
  );
}

export function currentWorkingDirectory(): string {
  return process.cwd();
}

export function warnBoundary(message: string): void {
  const warn = Reflect.get(console, "warn") as (message: string) => void;
  warn(message);
}

export function setEnvironmentValueForTest(name: string, value: string | undefined): void {
  const environment = Reflect.get(process, "env") as Record<string, string | undefined>;
  if (value === undefined) delete environment[name];
  else environment[name] = value;
}
