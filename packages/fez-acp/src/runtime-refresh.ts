import fs from "node:fs";

/** Work reservations include async admission and delayed dispatch, not just harness turns. */
export class RuntimeRefresh {
  private pending = 0;
  get idle(): boolean { return this.pending === 0; }
  async run<T>(work: () => Promise<T>, delay = 0): Promise<T> {
    this.pending++;
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return await work();
    } finally { this.pending--; }
  }
  watch(marker: string, running: string, idle: () => boolean, restart: () => void): () => void {
    const timer = setInterval(() => {
      if (this.pending || !idle()) return;
      let installed: string;
      try { installed = fs.readFileSync(marker, "utf8").trim(); } catch { return; }
      // A failed install can leave a NEW executable beside the OLD marker.
      // Refresh only forward, or that executable would restart itself forever.
      const version = /^\d+\.\d+\.\d+\+svc\d+$/;
      if (!version.test(installed) || !version.test(running) || installed.localeCompare(running, "en", { numeric: true }) <= 0) return;
      try {
        restart(); // Synchronous execve: no new message can enter between the gate and replacement.
        clearInterval(timer);
      } catch (error) {
        console.warn(`Agent update will retry: ${error instanceof Error ? error.message : error}`);
      }
    }, 5000);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
