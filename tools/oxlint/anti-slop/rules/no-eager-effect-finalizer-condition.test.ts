import { RuleTester } from "oxlint/plugins-dev";

import { noEagerEffectFinalizerConditionRule } from "./no-eager-effect-finalizer-condition.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const prelude = `import { Effect, Queue } from "effect";`;
const error = { messageId: "eagerCondition" };

const localCliPort = `
  import * as Effect from "effect/Effect";
  import * as Queue from "effect/Queue";
  const offer = (event, raw) => Effect.suspend(() => {
    if (raw) rawOwners.set(event, raw);
    let offered = false;
    return Queue.offer(events, event).pipe(
      Effect.tap(() => Effect.sync(() => void (offered = true))),
      Effect.ensuring(
        offered
          ? Effect.void
          : Effect.logWarning(
              \`Subagent local-CLI event ingress overflowed; dropped a \${event.type} event.\`,
            ).pipe(Effect.andThen(Effect.sync(() => raw && acknowledge(event)))),
      ),
      Effect.asVoid,
    );
  });
`;

tester.run("anti-slop/no-eager-effect-finalizer-condition", noEagerEffectFinalizerConditionRule, {
  valid: [
    `${prelude}
      const admitted = true;
      work.pipe(Effect.ensuring(admitted ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      Effect.sync(() => { offered = true; });
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(Effect.suspend(() => offered ? Effect.void : cleanup)));`,
    `${prelude}
      let confirmed = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { confirmed = true; })),
        Effect.ensuring(Effect.sync(() => { if (!confirmed) disable(); })));`,
    `import { Effect } from "another-library"; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
  ],
  invalid: [
    { code: localCliPort, errors: [error], output: null },
    {
      code: `${prelude}
        let offered = false;
        work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
          Effect.ensuring(offered && cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        const finalizer = offered ? Effect.void : cleanup;
        const alias = finalizer;
        Effect.sync(() => { offered = true; }).pipe(Effect.ensuring(alias));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.ensuring(
          Effect.tap(work, () => Effect.sync(() => { offered = true; })),
          offered ? Effect.void : cleanup);`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.gen(function* () { yield* Effect.sync(() => { offered = true; }); }).pipe(
          Effect.ensuring(offered ? Effect.void : cleanup));`,
      errors: [error],
    },
  ],
});

tester.run(
  "anti-slop/no-eager-effect-finalizer-condition file reset",
  noEagerEffectFinalizerConditionRule,
  {
    valid: [
      `let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
      `${prelude}
      let offered = false;
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
    ],
    invalid: [],
  },
);
