import { formatterSchedule } from "./formatter-tasks.ts";
import { wordingTasks } from "./wording-tasks.ts";
import { outputTasks } from "./output-tasks.ts";
import { tasks } from "./tasks.ts";

/** Pure offline plans, including archived cohorts. Planning never authorizes model execution. */
export function schedule(
  experiment: "adoption" | "output" | "wording" | "formatter" = "adoption",
  wordingSessions: 24 | 48 = 24,
) {
  if (experiment === "formatter") return formatterSchedule(wordingSessions);
  return (
    experiment === "wording" ? wordingTasks : experiment === "output" ? outputTasks : tasks
  ).flatMap((task, taskIndex) =>
    Array.from(
      {
        length:
          experiment === "wording" ? wordingSessions / 12 : task.split === "development" ? 1 : 2,
      },
      (_, repetition) => {
        const variants =
          (taskIndex + repetition) % 2 === 0
            ? (["baseline", "candidate"] as const)
            : (["candidate", "baseline"] as const);
        return variants.map((variant) => ({ task, variant, repetition }));
      },
    ).flat(),
  );
}
