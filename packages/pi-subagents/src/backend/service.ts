import * as Context from "effect/Context";
import type { BackendDriver } from "./model.ts";

export class SubagentBackendRegistry extends Context.Service<
  SubagentBackendRegistry,
  BackendDriver
>()("pi-subagents/backend/service/SubagentBackendRegistry") {}
