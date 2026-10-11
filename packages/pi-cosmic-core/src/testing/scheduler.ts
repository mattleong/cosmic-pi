import * as Scheduler from "effect/Scheduler";

export const pausedScheduler = () => {
  const tasks: Array<{ task: () => void; priority: number }> = [];
  const dispatcher = new Scheduler.MixedScheduler().makeDispatcher();
  let resumed = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "async",
    shouldYield: (fiber) => fiber.currentOpCount >= fiber.cache.maxOpsBeforeYield,
    makeDispatcher: () => ({
      scheduleTask: (task, priority) => {
        if (resumed) dispatcher.scheduleTask(task, priority);
        else tasks.push({ task, priority });
      },
      flush: () => {
        for (let next = tasks.shift(); next; next = tasks.shift()) next.task();
      },
    }),
  };
  return {
    scheduler,
    step: () => tasks.shift()?.task(),
    resume: () => {
      resumed = true;
      for (const { task, priority } of tasks.splice(0)) dispatcher.scheduleTask(task, priority);
    },
  };
};

export const interruptingScheduler = (shouldInterrupt: () => boolean): Scheduler.Scheduler => {
  const scheduler = new Scheduler.MixedScheduler();
  return {
    executionMode: scheduler.executionMode,
    makeDispatcher: () => scheduler.makeDispatcher(),
    shouldYield: (fiber) => {
      if (!shouldInterrupt()) return false;
      fiber.interruptUnsafe();
      return true;
    },
  };
};
