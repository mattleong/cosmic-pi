import * as Str from "effect/String";

const hasRelayMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.PI_SUBAGENT_CHILD === "1" && Str.trim(environment.PI_SUBAGENT_RUN_ID ?? "") !== "";

export const requiresQuestionnaireRelay = (): boolean => hasRelayMarker(process.env);
