import { spawn } from "node:child_process";
import { Socket } from "node:net";

const mode = process.argv[2] ?? "echo";
const ready = () => process.stdout.write("ready\n");

if (mode === "echo") {
  process.stdin.on("data", (chunk) => process.stdout.write(chunk));
  process.stdin.on("end", () => process.exit(0));
} else if (mode === "ignore-term" || mode === "stall-stdin") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdin.pause();
  setInterval(() => {}, 1_000);
  ready();
} else if (mode === "descendant" || mode === "late-writer") {
  process.on("SIGTERM", () => {});
  if (mode === "late-writer") {
    process.on("disconnect", () => {
      setTimeout(() => process.stdout.end("after-exit\n", () => process.exit(0)), 30);
    });
  }
  setInterval(() => {}, 1_000);
  process.send("ready");
} else if (mode === "hold-pipes" || mode === "parent-exits" || mode === "late-output") {
  const child = spawn(
    process.execPath,
    [process.argv[1], mode === "late-output" ? "late-writer" : "descendant"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {},
    },
  );
  process.on("SIGTERM", () => process.exit(0));
  child.once("message", () => {
    process.stdout.write("ready:" + child.pid + "\n", () => {
      if (mode !== "hold-pipes") process.exit(0);
    });
  });
} else if (mode === "burst" || mode === "stderr") {
  const size = Number(process.argv[3] ?? "65536");
  process.stdin.once("data", () => {
    const stream = mode === "burst" ? process.stdout : process.stderr;
    stream.write(Buffer.alloc(Number.isFinite(size) ? size : 0, 97), () => process.exit(0));
  });
  ready();
} else if (mode === "side-channel") {
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const lease = new Socket({ fd: 4, readable: true, writable: false });
  lease.resume();
  process.stdout.write("out:" + (process.stdin === null ? "none" : "stdin") + "\n");
  process.stderr.write("err\n");
  channel.on("data", (chunk) => channel.write(chunk));
  channel.on("end", () => process.exit(0));
} else {
  process.stderr.write("unknown mode\n");
  process.exit(2);
}
