export const HERDR_BTW_COMMAND = "herdr-btw";
export const HERDR_BTW_NEW_SUBCOMMAND = "new";

export const HERDR_ENVIRONMENT_UNAVAILABLE_MESSAGE =
  "Herdr BTW only works in a Pi session inside a Herdr pane";

export const isHerdrEnvironment = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.HERDR_ENV === "1";
