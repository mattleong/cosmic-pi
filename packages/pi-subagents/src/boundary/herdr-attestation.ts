// Private filesystem receipts causally attest protected Herdr pane startup commands.
import { randomBytes } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { processError, SubagentProcessError } from "../run/errors.ts";
import { MAX_PATH_CHARS, nodeErrorCode, shellQuote } from "./harness-shared.ts";
import { nodeFsConstants as constants, nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

const { join } = nodePath;

const RECEIPT_TOKEN_BYTES = 24;
const RECEIPT_PATH_NONCE_BYTES = 8;
const MAX_RECEIPT_BYTES = RECEIPT_TOKEN_BYTES * 2 + 1;
const DEFAULT_POLL_ATTEMPTS = 51;
const DEFAULT_POLL_DELAY_MILLIS = 100;

const RECEIPT_PHASES = [
  "activation-1",
  "activation-2",
  "environment-ready",
  "post-environment-shell",
  "secret-ready",
  "post-secret-shell",
] as const;

export type HerdrStartupReceiptPhase = (typeof RECEIPT_PHASES)[number];

export interface HerdrStartupReceipt {
  readonly phase: HerdrStartupReceiptPhase;
  /** Fixed pane command that atomically publishes only this receipt. */
  readonly command: string;
  /** Private boundary-test inspection only. Never log or expose this path diagnostically. */
  readonly path: string;
  /** Private boundary-test inspection only. */
  readonly temporaryPath: string;
  readonly observe: Effect.Effect<void, SubagentProcessError>;
}

export interface HerdrStartupAttestation {
  readonly activationReceipt: (attempt: 1 | 2) => HerdrStartupReceipt;
  readonly environmentReadyReceipt: HerdrStartupReceipt;
  readonly postEnvironmentShellReceipt: HerdrStartupReceipt;
  readonly secretReadyReceipt: HerdrStartupReceipt;
  readonly postSecretShellReceipt: HerdrStartupReceipt;
}

export interface HerdrStartupAttestationOptions {
  /** Test seam only. */
  readonly pollAttempts?: number | undefined;
  /** Test seam only. */
  readonly pollDelayMillis?: number | undefined;
}

interface ReceiptPlan {
  readonly phase: HerdrStartupReceiptPhase;
  readonly path: string;
  readonly temporaryPath: string;
  readonly expected: string;
}

const atomicReceiptCommand = (plan: ReceiptPlan): string =>
  `(umask 077; set -C; printf '%s%s\\n' ${shellQuote(plan.expected.slice(0, 24))} ${shellQuote(plan.expected.slice(24))} > ${shellQuote(plan.temporaryPath)} && /bin/mv -f ${shellQuote(plan.temporaryPath)} ${shellQuote(plan.path)})`;

const assertAbsent = (path: string): Promise<void> =>
  fs.lstat(path).then(
    () => Promise.reject(new Error("startup-receipt-not-absent")),
    (error) =>
      nodeErrorCode(error) === "ENOENT"
        ? Promise.resolve()
        : Promise.reject(new Error("startup-receipt-absence-unconfirmed")),
  );

const readReceipt = (plan: ReceiptPlan): Promise<"absent" | "valid"> =>
  fs.lstat(plan.path).then(
    (pathStat) => {
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        pathStat.size < 1 ||
        pathStat.size > MAX_RECEIPT_BYTES
      )
        return Promise.reject(new Error("startup-receipt-invalid-file"));
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      return fs
        .open(plan.path, constants.O_RDONLY | noFollow)
        .catch(() => Promise.reject(new Error("startup-receipt-open-failed")))
        .then((handle) =>
          handle
            .stat()
            .then((openedStat) => {
              if (
                !openedStat.isFile() ||
                openedStat.size < 1 ||
                openedStat.size > MAX_RECEIPT_BYTES ||
                openedStat.dev !== pathStat.dev ||
                openedStat.ino !== pathStat.ino
              )
                throw new Error("startup-receipt-identity-invalid");
              return handle.readFile({ encoding: "utf8" });
            })
            .then((source) => {
              if (
                Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES ||
                source !== `${plan.expected}\n`
              )
                throw new Error("startup-receipt-content-invalid");
              return "valid" as const;
            })
            .finally(() => handle.close().catch(() => undefined)),
        );
    },
    (error) =>
      nodeErrorCode(error) === "ENOENT"
        ? Promise.resolve("absent" as const)
        : Promise.reject(new Error("startup-receipt-inspection-failed")),
  );

const receiptDiagnostic = (
  level: "debug" | "warning",
  phase: HerdrStartupReceiptPhase,
  outcome: "observed" | "invalid" | "timeout",
): Effect.Effect<void> => {
  const diagnostic = { event: "herdr_startup_receipt", phase, outcome } as const;
  return level === "debug" ? Effect.logDebug(diagnostic) : Effect.logWarning(diagnostic);
};

const observeReceipt = (
  plan: ReceiptPlan,
  pollAttempts: number,
  pollDelayMillis: number,
): Effect.Effect<void, SubagentProcessError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const status = yield* Effect.tryPromise({
        try: () => readReceipt(plan),
        catch: () =>
          processError(
            "validate Herdr startup receipt",
            "herdr_startup_receipt_invalid",
            "A private Herdr startup receipt was a symlink, non-regular file, identity mismatch, oversized value, or wrong/partial content.",
          ),
      }).pipe(Effect.tapError(() => receiptDiagnostic("warning", plan.phase, "invalid")));
      if (status === "valid") {
        yield* receiptDiagnostic("debug", plan.phase, "observed");
        return;
      }
      if (attempt < pollAttempts) yield* Effect.sleep(Duration.millis(pollDelayMillis));
    }
    yield* receiptDiagnostic("warning", plan.phase, "timeout");
    return yield* processError(
      "observe Herdr startup receipt",
      "herdr_startup_receipt_timeout",
      "The expected private Herdr startup receipt remained absent for the bounded observation window.",
    );
  });

/**
 * Allocates unique receipt names/tokens inside one already-owned 0700 run harness and proves that
 * every final and temporary path starts absent before any pane command can be built or observed.
 */
export const prepareHerdrStartupAttestation = (
  directory: string,
  options: HerdrStartupAttestationOptions = {},
): Promise<HerdrStartupAttestation> => {
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollDelayMillis = options.pollDelayMillis ?? DEFAULT_POLL_DELAY_MILLIS;
  const plans = RECEIPT_PHASES.map((phase): ReceiptPlan => {
    const pathNonce = randomBytes(RECEIPT_PATH_NONCE_BYTES).toString("hex");
    const path = join(directory, `.startup-${phase}-${pathNonce}.receipt`);
    const temporaryPath = join(directory, `.startup-${phase}-${pathNonce}.tmp`);
    if (path.length > MAX_PATH_CHARS || temporaryPath.length > MAX_PATH_CHARS)
      throw new Error("startup-receipt-path-too-large");
    return {
      phase,
      path,
      temporaryPath,
      expected: randomBytes(RECEIPT_TOKEN_BYTES).toString("hex"),
    };
  });
  if (
    new Set(plans.map((plan) => plan.path)).size !== plans.length ||
    new Set(plans.map((plan) => plan.expected)).size !== plans.length
  )
    throw new Error("startup-receipt-collision");
  return Promise.all(
    plans.flatMap((plan) => [assertAbsent(plan.path), assertAbsent(plan.temporaryPath)]),
  ).then(() => {
    const receipts = new Map(
      plans.map((plan) => [
        plan.phase,
        {
          phase: plan.phase,
          command: atomicReceiptCommand(plan),
          path: plan.path,
          temporaryPath: plan.temporaryPath,
          observe: observeReceipt(plan, pollAttempts, pollDelayMillis),
        } satisfies HerdrStartupReceipt,
      ]),
    );
    const receipt = (phase: HerdrStartupReceiptPhase): HerdrStartupReceipt => receipts.get(phase)!;
    return {
      activationReceipt: (attempt) => receipt(attempt === 1 ? "activation-1" : "activation-2"),
      environmentReadyReceipt: receipt("environment-ready"),
      postEnvironmentShellReceipt: receipt("post-environment-shell"),
      secretReadyReceipt: receipt("secret-ready"),
      postSecretShellReceipt: receipt("post-secret-shell"),
    };
  });
};
