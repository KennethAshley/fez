import { check } from "@tauri-apps/plugin-updater";
import { toast } from "./toast";

/**
 * One launch-time update check against the GitHub Releases feed
 * (latest.json, signature verified against the pubkey baked into
 * tauri.conf). Quiet by design: no release, no network, no update —
 * nothing shows. When there IS one it downloads in the background and
 * leaves a sticky toast; the swap happens on next launch, so nothing
 * interrupts whatever the user is doing.
 */
export function startUpdateCheck(): void {
  void (async () => {
    try {
      const update = await check();
      if (!update) return;
      toast.info(`fez ${update.version} is available — downloading in the background…`);
      await update.downloadAndInstall();
      toast.info(`fez ${update.version} is ready — quit and reopen fez to finish updating`, 0);
    } catch {
      // Offline, rate-limited, or no releases yet — next launch retries.
    }
  })();
}
