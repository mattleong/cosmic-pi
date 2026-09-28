// Worker thread for the Code Mode program process. Pi holds the other end of fd 4 open for
// the program's lifetime; EOF or an error there means Pi is gone. This thread has its own
// event loop, so it kills the whole process group even while the program is stuck in a loop.
// A socket, not an fs stream: a blocking thread-pool read would stall the process's own exit.
import { Socket } from "node:net";
import { parentPort } from "node:worker_threads";

const kill = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.kill(process.pid, "SIGKILL");
  }
};

const lease = new Socket({ fd: 4, readable: true, writable: false });
lease.on("data", () => {});
lease.once("end", kill);
lease.once("error", kill);
parentPort?.postMessage("ready");
