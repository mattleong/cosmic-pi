import { signalProcess } from "pi-cosmic-core";
import { pollUntil } from "pi-cosmic-core/testing";

export const processAlive = (pid: number): boolean => signalProcess(pid, 0) !== "absent";

export const waitForDead = (pid: number) => pollUntil(() => !processAlive(pid));
