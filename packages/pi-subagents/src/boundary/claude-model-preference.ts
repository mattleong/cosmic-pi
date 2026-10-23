import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import { type SafeFileContract } from "pi-cosmic-core/platform/safe-file";
import { nodeFsPromises as fs, nodePath } from "pi-cosmic-core/platform/node-builtins";
import { isSafeNativeModelSelector } from "../profiles/model.ts";

const MAX_SETTINGS_BYTES = 64 * 1024;
const UserModelPreference = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String.check(Schema.makeFilter(isSafeNativeModelSelector)),
  }),
);
const decodePreference = Schema.decodeUnknownEffect(UserModelPreference);

export const readClaudeModelPreference = Effect.fn("ClaudeModelPreference.read")(
  function* (environment: NodeJS.ProcessEnv, safeFile: SafeFileContract) {
    const home = (environment.HOME ?? "") || homedir();
    if (!nodePath.isAbsolute(home) || home.length > 4_096 || /\p{Cc}/u.test(home)) return "default";
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
  },
  Effect.orElseSucceed(() => "default"),
);
