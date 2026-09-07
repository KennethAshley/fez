import { spawn } from "node:child_process";

export function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function spawnDetached(bin: string, args: string[], env: Record<string, string> = {}): number {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${bin}`);
  return child.pid;
}
export function kill(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
}
