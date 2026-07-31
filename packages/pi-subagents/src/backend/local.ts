import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess } from "../boundary/child-process.ts";
import { LocalCliProcess } from "../boundary/local-cli-process.ts";
import { SupervisorChannel } from "../boundary/supervisor-channel.ts";
import { HerdrHost } from "../boundary/herdr-host.ts";
import { makeHerdrBackendDriver } from "./herdr.ts";
import { makeLocalClaudeBackendDriver } from "./local-claude.ts";
import { makeLocalCodexBackendDriver } from "./local-codex.ts";
import { makeLocalPiBackendDriver } from "./local-pi.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "./service.ts";

/** One memoized registry owns all six implemented drivers and their shared boundary services. */
export const subagentBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  Effect.gen(function* () {
    const children = yield* ChildProcess;
    const localCli = yield* LocalCliProcess;
    const supervisor = yield* SupervisorChannel;
    const herdr = yield* HerdrHost;
    return makeSubagentBackendRegistry([
      makeLocalPiBackendDriver(children),
      makeLocalClaudeBackendDriver(localCli, supervisor),
      makeLocalCodexBackendDriver(localCli, supervisor),
      makeHerdrBackendDriver("pi", herdr, supervisor),
      makeHerdrBackendDriver("claude", herdr, supervisor),
      makeHerdrBackendDriver("codex", herdr, supervisor),
    ]);
  }),
);
