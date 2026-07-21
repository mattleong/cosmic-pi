/** Thin public entrypoint for the Advisor application. */
export { advisorExtension, createAdvisorExtension } from "./application/register.ts";
export {
  ADVISOR_CATCH_UP_TIMEOUT_MS,
  AdvisorController,
  AdvisorExtensionError,
  advisorControllerApplicationLayer,
  advisorControllerLayer,
  awaitAdvisorCatchUpEffect,
  type AdvisorCatchUpOutcome,
  type AdvisorControllerApplicationOptions,
  type AdvisorExtensionDependencies,
  type AdvisorSkipReason,
} from "./application/controller.ts";
