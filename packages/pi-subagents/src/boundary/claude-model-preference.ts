// Read only the user model selector, never Claude's executable settings or project config.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import { type SafeFileContract } from "pi-cosmic-core";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

const MAX_SETTINGS_BYTES = 64 * 1024;
const UserModelPreference = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String.check(Schema.makeFilter(isSafeNativeModelSelector)),
  }),
);
const decodePreference = Schema.decodeUnknownEffect(UserModelPreference);

/** The caller supplies the sanitized child environment, so stripped config overrides stay stripped. */
export const readClaudeModelPreference = (
  environment: NodeJS.ProcessEnv,
  safeFile: SafeFileContract,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const home = environment.HOME || homedir();
    if (!nodePath.isAbsolute(home) || home.length > 4_096 || /\p{Cc}/u.test(home)) return "default";
    // Follow only this user-owned config link, including common dotfile-manager layouts.
    const path = yield* Effect.tryPromise(() =>
      fs.realpath(nodePath.join(home, ".claude", "settings.json")),
    );
    const file = yield* safeFile.readContainedRegularFile(
      path,
      nodePath.dirname(path),
      MAX_SETTINGS_BYTES,
    );
    const preference = yield* decodePreference(new TextDecoder().decode(file.bytes));
    return preference.model;
  }).pipe(Effect.orElseSucceed(() => "default"));
