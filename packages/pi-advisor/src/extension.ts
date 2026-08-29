/** Thin public entrypoint for the Advisor application. */
export { advisorExtension, createAdvisorExtension } from "./application/register.ts";
export {
  ADVISOR_CATCH_UP_TIMEOUT_MS,
  AdvisorExtensionError,
  awaitAdvisorCatchUpEffect,
  type AdvisorCatchUpOutcome,
  type AdvisorControllerApplicationOptions,
  type AdvisorExtensionDependencies,
} from "./application/controller.ts";
