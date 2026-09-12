import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";

/** Desktop-owned agents clean up if their owner disappears; returns the same stop action used by signals. */
export function bindAgentLifetime(close: () => Promise<void>, parent = process.env.FEZ_DESKTOP_PARENT_PID): () => void {
  const parentPid = parent ? Number(parent) : undefined;
  if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid <= 1)) {
    throw new Error("Invalid desktop parent PID");
  }
  // Native desktop spawns a dedicated group. Never signal a shared shell group.
  let ownsGroup = false;
  if (parentPid !== undefined && process.platform !== "win32") {
    ownsGroup = Number(execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" }).trim()) === process.pid;
  }
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    clearInterval(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("exit", dispose);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    let exitCode = 1;
    const finish = (code: number) => {
      if (ownsGroup) {
        // Retain the group leader until escalation, preventing PID reuse. This
        // also catches adapters still opening and absent from the session pool.
        // SIGKILL also ends this leader; preserve successful intentional exits
        // for the native reaper, which otherwise sees every idle exit as a crash.
        if (code === 0) { try { writeSync(1, `FEZ_AGENT_STOPPED=${process.pid}\n`); } catch {} }
        try { process.kill(-process.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      process.exit(code);
    };
    const deadline = setTimeout(() => finish(exitCode), 2000);
    if (ownsGroup) process.kill(-process.pid, "SIGTERM");
    void Promise.resolve().then(close).then(
      () => { exitCode = 0; if (!ownsGroup) { clearTimeout(deadline); finish(0); } },
      () => { if (!ownsGroup) { clearTimeout(deadline); finish(1); } },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", dispose);
  if (parentPid !== undefined) {
    timer = setInterval(() => {
      try { process.kill(parentPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") stop();
      }
    }, 1000);
    timer.unref();
  }
  return stop;
}
