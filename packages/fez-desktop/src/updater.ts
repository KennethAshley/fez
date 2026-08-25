import { check } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "./toast";

/**
 * Two ways in, one flow. The launch-time check stays quiet by design: no
 * release, no network, no update — nothing shows. The menu-bar
 * "Check for Updates…" is the loud twin: every outcome gets a toast,
 * including failure — a feed that 404s for months while the silent path
 * swallowed it is exactly why the interactive path exists.
 */
let running = false;

async function runCheck(interactive: boolean): Promise<void> {
  if (running) {
    if (interactive) toast.info("Already checking for updates…");
    return;
  }
  running = true;
  try {
    if (interactive) toast.info("Checking for updates…");
    const update = await check();
    if (!update) {
      if (interactive) {
        const version = await getVersion().catch(() => "");
        toast.success(version ? `fez ${version} is up to date.` : "fez is up to date.");
      }
      return;
    }
    toast.info(`fez ${update.version} is available — downloading in the background…`);
    await update.downloadAndInstall();
    toast.info(`fez ${update.version} is ready — quit and reopen fez to finish updating`, 0);
  } catch (err) {
    // Offline, rate-limited, or no reachable release — next launch retries.
    if (interactive) {
      toast.error(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    running = false;
  }
}

export function startUpdateCheck(): void {
  void runCheck(false);
  void listen("fez-check-updates", () => void runCheck(true));
}
